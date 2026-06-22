/**
 * Milestone-3 MULTI-LEASE proof harness for @render/opencli-bridge.
 *
 * Proves the full tab lifecycle against Render's OWN multiple WebContentsViews —
 * the SAME production transport (`createWebContentsTarget` over
 * `webContents.debugger`) the bridge uses, NO mocks in the execution path. We
 * exercise `dispatch` directly (the exact function the bridge's onMessage calls)
 * with the multi-lease provider + real network/download caps, and assert on
 * PAYLOAD (distinct stable targetIds, correct lease answered, real PNG bytes
 * from a NON-active lease, a real captured network request, a real downloaded
 * file), not just ok:true.
 *
 * ⛔ This NEVER touches system Chrome. It drives only Render's own
 * WebContentsViews and serves its OWN local HTTP fixtures on 127.0.0.1 — no
 * opencli daemon, no default profile, no `opencli` command at all.
 *
 * ── Multi-view screenshot compositing (the M2 QA flag, resolved) ─────────────
 * ONE shared off-screen host BaseWindow, shown once via showInactive() (parked
 * far off any display, never steals focus). Each lease is a child
 * WebContentsView given a DISTINCT non-overlapping off-screen rect so EVERY view
 * composites simultaneously. Because each view has its own webContents + own CDP
 * page target, Page.captureScreenshot renders that page's own surface — so a
 * NON-active lease screenshots without z-order churn or per-display surface
 * blowup. We assert exactly that (screenshot the non-active lease).
 *
 * We import `electron` only here (harness), keeping the library Electron-free.
 */

import { app, BaseWindow, WebContentsView, session as electronSession } from 'electron';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createMultiWebContentsLeaseProvider } from '../src/view-provider.js';
import { createNetworkCaptureRegistry } from '../src/network-capture.js';
import { dispatch } from '../src/actions.js';
import type { CommandFrame, ResultFrame } from '../src/types.js';
import type { MultiLeaseProvider } from '../src/multi-lease.js';
import type { WcContents } from '../src/webcontents-target.js';
import type { DispatchCaps } from '../src/actions.js';

const EVIDENCE_DIR = process.env.M3_EVIDENCE_DIR ?? resolve(process.cwd(), 'harness/evidence/m3');
const PROGRESS_LOG = resolve(EVIDENCE_DIR, 'progress.log');
const DOWNLOAD_DIR = resolve(EVIDENCE_DIR, 'downloads');

const prog = (msg: string): void => {
  try {
    appendFileSync(PROGRESS_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* best effort */
  }
  process.stdout.write(`[m3] ${msg}\n`);
};

interface Step {
  name: string;
  pass: boolean;
  detail: unknown;
}
const isOk = (r: ResultFrame): r is Extract<ResultFrame, { ok: true }> => r.ok === true;

/**
 * Two DISTINCT 127.0.0.1 fixtures (so lease isolation is provable by content),
 * a /api/ endpoint for network capture, and a /download endpoint serving a file
 * with Content-Disposition so the browser downloads it.
 */
function startFixtures(): Promise<{
  siteA: string;
  siteB: string;
  apiPathA: string;
  downloadUrlA: string;
  close: () => void;
}> {
  return new Promise((resolveServer) => {
    const make = (label: string, marker: string) =>
      createServer((req, res) => {
        const url = req.url ?? '/';
        if (url.startsWith('/api/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ marker, path: url, ok: true }));
          return;
        }
        if (url.startsWith('/download')) {
          const body = `RENDER-M3-DOWNLOAD-${marker}\n`.repeat(8);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="render-m3-${marker}.bin"`,
          });
          res.end(body);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!doctype html><title>${label}</title>` +
            `<h1 id="marker">${marker}</h1>` +
            `<script>window.__SITE__=${JSON.stringify(marker)};` +
            `fetch('/api/${marker}-fetch').catch(()=>{});</script>`,
        );
      });
    const a = make('site A', 'AAA');
    const b = make('site B', 'BBB');
    a.listen(0, '127.0.0.1', () => {
      const ap = (a.address() as AddressInfo).port;
      b.listen(0, '127.0.0.1', () => {
        const bp = (b.address() as AddressInfo).port;
        resolveServer({
          siteA: `http://127.0.0.1:${ap}/`,
          siteB: `http://127.0.0.1:${bp}/`,
          apiPathA: `http://127.0.0.1:${ap}/api/`,
          downloadUrlA: `http://127.0.0.1:${ap}/download`,
          close: () => {
            a.close();
            b.close();
          },
        });
      });
    });
  });
}

async function run(
  provider: MultiLeaseProvider,
  caps: DispatchCaps,
  fx: { siteA: string; siteB: string; apiPathA: string; downloadUrlA: string },
): Promise<Step[]> {
  const steps: Step[] = [];
  let n = 0;
  const cmd = (c: Omit<CommandFrame, 'id'>): CommandFrame => ({ id: `m3_${++n}`, ...c });

  // ── (1) tabs new ×2 → distinct stable targetIds, navigate each to a DIFFERENT site
  prog('tabs new (lease 1) → site A');
  const new1 = await dispatch(provider, cmd({ action: 'tabs', op: 'new', url: fx.siteA }));
  prog('tabs new (lease 2) → site B');
  const new2 = await dispatch(provider, cmd({ action: 'tabs', op: 'new', url: fx.siteB }));
  const page1 = isOk(new1) ? new1.page : undefined;
  const page2 = isOk(new2) ? new2.page : undefined;
  const distinct = !!page1 && !!page2 && page1 !== page2;
  steps.push({
    name: 'tabs-new-x2-distinct-stable-targetIds',
    pass: isOk(new1) && isOk(new2) && distinct,
    detail: { page1, page2, distinct },
  });
  if (!page1 || !page2) throw new Error(`tabs new failed: ${JSON.stringify([new1, new2])}`);

  // ── (2) lease isolation: exec the site marker on each lease, expect the RIGHT page
  prog('exec marker on lease 1');
  const execA = await dispatch(provider, cmd({ action: 'exec', page: page1, code: 'window.__SITE__' }));
  prog('exec marker on lease 2');
  const execB = await dispatch(provider, cmd({ action: 'exec', page: page2, code: 'window.__SITE__' }));
  const isoPass =
    isOk(execA) && execA.data === 'AAA' && execA.page === page1 &&
    isOk(execB) && execB.data === 'BBB' && execB.page === page2;
  steps.push({
    name: 'lease-isolation-correct-page-answered',
    pass: isoPass,
    detail: { lease1: isOk(execA) ? execA.data : execA, lease2: isOk(execB) ? execB.data : execB },
  });

  // stable targetId across a SECOND navigation within lease 1
  prog('re-navigate lease 1 (stable id check)');
  const renav = await dispatch(provider, cmd({ action: 'navigate', page: page1, url: `${fx.siteA}?again=1` }));
  steps.push({
    name: 'stable-targetId-across-navigation',
    pass: isOk(renav) && renav.page === page1,
    detail: { before: page1, after: isOk(renav) ? renav.page : null },
  });

  // ── (3) tabs list shows BOTH leases, with stable pages + active flag
  prog('tabs list');
  const list = await dispatch(provider, cmd({ action: 'tabs', op: 'list' }));
  const tabs = isOk(list) && Array.isArray(list.data) ? (list.data as Array<Record<string, unknown>>) : [];
  const listPages = tabs.map((t) => t.page);
  const listPass =
    isOk(list) && !('page' in list) && tabs.length === 2 &&
    listPages.includes(page1) && listPages.includes(page2);
  steps.push({ name: 'tabs-list-shows-both', pass: listPass, detail: { count: tabs.length, tabs } });

  // ── (4) network capture a REAL request on lease 1 ────────────────────────────
  prog('network-capture-start on lease 1');
  await dispatch(provider, cmd({ action: 'network-capture-start', page: page1, pattern: '/api/' }), caps);
  // trigger a real fetch to /api/ on lease 1
  await dispatch(provider, cmd({ action: 'exec', page: page1, code: `fetch(${JSON.stringify(`${fx.apiPathA}captured`)}).then(r=>r.text())` }));
  await delay(600);
  const capRead = await dispatch(provider, cmd({ action: 'network-capture-read', page: page1 }), caps);
  const entries = isOk(capRead) && Array.isArray(capRead.data) ? (capRead.data as Array<Record<string, unknown>>) : [];
  const captured = entries.find((e) => typeof e.url === 'string' && (e.url as string).includes('/api/captured'));
  const capPass = isOk(capRead) && capRead.page === page1 && !!captured && captured.kind === 'cdp';
  steps.push({ name: 'network-capture-real-request', pass: capPass, detail: { count: entries.length, captured: captured ?? null } });

  // ── (5) screenshot a NON-ACTIVE lease (lease 1; lease 2 was minted last → active)
  prog('select lease 2 so lease 1 is NON-active');
  await dispatch(provider, cmd({ action: 'tabs', op: 'select', page: page2 }));
  prog('screenshot the NON-active lease (lease 1)');
  const shot = await dispatch(provider, cmd({ action: 'screenshot', page: page1 }));
  let pngOk = false;
  let pngInfo: Record<string, unknown> = {};
  if (isOk(shot) && typeof shot.data === 'string' && shot.data.length > 0) {
    const buf = Buffer.from(shot.data, 'base64');
    const magic = buf.subarray(0, 8).toString('hex');
    pngOk = magic === '89504e470d0a1a0a' && buf.length > 1000 && shot.page === page1;
    pngInfo = { magicHex: magic, byteLength: buf.length, page: shot.page, nonActiveLease: page1 };
    writeFileSync(resolve(EVIDENCE_DIR, 'screenshot-nonactive-lease.png'), buf);
  }
  steps.push({ name: 'screenshot-NON-active-lease', pass: pngOk, detail: pngInfo });

  // ── (6) wait-download a REAL file on lease 2 ─────────────────────────────────
  prog('wait-download on lease 2 (real file)');
  const dlPromise = dispatch(
    provider,
    cmd({ action: 'wait-download', page: page2, pattern: 'render-m3', timeoutMs: 12_000 }),
    caps,
  );
  // trigger the download by navigating the lease to the download URL via exec
  await dispatch(provider, cmd({ action: 'exec', page: page2, code: `(()=>{const a=document.createElement('a');a.href=${JSON.stringify(fx.downloadUrlA)};a.download='';document.body.appendChild(a);a.click();return true;})()` }));
  const dl = await dlPromise;
  const dlData = isOk(dl) ? (dl.data as Record<string, unknown>) : {};
  // Verify a file actually landed on disk. CDP `allowAndName` saves the file
  // under its download GUID (not the suggested filename), so we verify by
  // largest non-empty file in the dir — the bytes are what matter as proof.
  const onDisk = existsSync(DOWNLOAD_DIR) ? readdirSync(DOWNLOAD_DIR) : [];
  let landed: string | undefined;
  let landedSize = 0;
  for (const f of onDisk) {
    try {
      const sz = statSync(join(DOWNLOAD_DIR, f)).size;
      if (sz > landedSize) {
        landedSize = sz;
        landed = f;
      }
    } catch {
      /* skip */
    }
  }
  const dlPass = isOk(dl) && dlData.downloaded === true && dlData.state === 'complete' && landedSize > 0;
  steps.push({
    name: 'wait-download-real-file',
    pass: dlPass,
    detail: { result: dlData, onDisk, landed, landedSize },
  });

  // ── (7) tabs close one lease → gone + target disposed
  prog('tabs close lease 1');
  const close = await dispatch(provider, cmd({ action: 'tabs', op: 'close', page: page1 }));
  const closePass = isOk(close) && (close.data as { closed?: string }).closed === page1 && !('page' in close);
  const listAfter = await dispatch(provider, cmd({ action: 'tabs', op: 'list' }));
  const afterTabs = isOk(listAfter) && Array.isArray(listAfter.data) ? (listAfter.data as Array<Record<string, unknown>>) : [];
  const goneFromList = !afterTabs.some((t) => t.page === page1) && afterTabs.length === 1;
  // addressing the disposed lease now throws stale-page → mapped to ok:false by the bridge.
  let staleDisposed = false;
  try {
    await dispatch(provider, cmd({ action: 'exec', page: page1, code: '1' }));
  } catch (err) {
    staleDisposed = err instanceof Error && (err as { errorCode?: string }).errorCode === 'stale_page';
  }
  steps.push({
    name: 'tabs-close-disposes-target',
    pass: closePass && goneFromList && staleDisposed,
    detail: { closed: isOk(close) ? close.data : close, remaining: afterTabs.length, staleAfterClose: staleDisposed },
  });

  for (const s of steps) prog(`step ${s.name}: ${s.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(s.detail).slice(0, 300)}`);
  return steps;
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  writeFileSync(PROGRESS_LOG, '');
  prog('main start; awaiting app.whenReady');
  await app.whenReady();
  prog('app ready');

  // Route CDP downloads into our evidence dir for THIS session (Render's own
  // session, never system Chrome's). Belt-and-suspenders alongside the per-target
  // Browser.setDownloadBehavior the download module issues.
  try {
    electronSession.defaultSession.on('will-download', (_e, item) => {
      item.setSavePath(join(DOWNLOAD_DIR, item.getFilename()));
    });
  } catch {
    /* best effort */
  }

  // ── ONE shared off-screen compositing host (see header). Shown via showInactive
  // so its compositor is live but invisible + never steals focus.
  const HOST_W = 1280;
  const HOST_H = 900;
  const win = new BaseWindow({ width: HOST_W, height: HOST_H, show: false, x: -10000, y: -10000 });
  win.showInactive();

  // Each lease gets a DISTINCT non-overlapping off-screen rect inside the host so
  // every view composites simultaneously (required to screenshot a non-active one).
  const VIEW_W = 600;
  const VIEW_H = 800;
  let slot = 0;
  const liveViews: WebContentsView[] = [];

  const provider = createMultiWebContentsLeaseProvider({
    mintView: async () => {
      const v = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, offscreen: false } });
      win.contentView.addChildView(v);
      // tile horizontally inside the host; both fully within the 1280-wide host.
      v.setBounds({ x: slot * VIEW_W, y: 0, width: VIEW_W, height: VIEW_H });
      slot += 1;
      liveViews.push(v);
      await v.webContents.loadURL('about:blank');
      return {
        webContents: v.webContents as unknown as WcContents,
        destroy: () => {
          try {
            win.contentView.removeChildView(v);
            v.webContents.close();
          } catch {
            /* already gone */
          }
        },
      };
    },
  });

  const caps: DispatchCaps = {
    network: createNetworkCaptureRegistry(),
    download: {
      downloadPath: DOWNLOAD_DIR,
      // CDP `allowAndName` writes the file under its GUID, not the suggested
      // filename, so the on-disk path is <downloadPath>/<guid>.
      resolveSavePath: (guid, _name) => join(DOWNLOAD_DIR, guid),
      fileSize: (p) => {
        try {
          return statSync(p).size;
        } catch {
          return 0;
        }
      },
    },
  };

  const fixtures = await startFixtures();
  prog(`fixtures up: A=${fixtures.siteA} B=${fixtures.siteB}`);
  let summary: Record<string, unknown>;
  try {
    const steps = await run(provider, caps, fixtures);
    const pass = steps.every((s) => s.pass);
    summary = {
      verdict: pass ? 'PASS' : 'FAIL',
      fixtures: { siteA: fixtures.siteA, siteB: fixtures.siteB },
      compositing: 'single shared off-screen host BaseWindow (showInactive); each lease a child WebContentsView at a distinct non-overlapping off-screen rect',
      steps,
      ts: new Date().toISOString(),
    };
  } catch (err) {
    summary = { verdict: 'FAIL', error: err instanceof Error ? err.stack : String(err), ts: new Date().toISOString() };
  } finally {
    fixtures.close();
    await provider.dispose().catch(() => {});
  }

  writeFileSync(resolve(EVIDENCE_DIR, 'verdict.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(`__M3_VERDICT__ ${JSON.stringify(summary)}\n`);
  app.exit(summary.verdict === 'PASS' ? 0 : 1);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  process.stderr.write(`[m3-fatal] ${err instanceof Error ? err.stack : String(err)}\n`);
  app.exit(1);
});
