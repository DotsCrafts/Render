/**
 * Milestone-2 ACTION proof harness for @render/opencli-bridge.
 *
 * Proves the four single-lease actions (cdp, cookies, screenshot, frames)
 * against Render's OWN off-screen WebContentsView — the SAME production
 * transport (`createWebContentsTarget` over `webContents.debugger`) the bridge
 * uses, NO mocks in the execution path. We exercise `dispatch` directly (the
 * exact function the bridge's onMessage calls) so the action handlers run end to
 * end over real CDP, and assert on PAYLOAD (PNG magic bytes, real cookie values,
 * a real CDP round-trip, a real cross-origin frame), not just an ok:true.
 *
 * ⛔ This NEVER touches system Chrome. It drives only Render's own WebContentsView
 * and serves its OWN local HTTP fixtures on 127.0.0.1 — no opencli daemon, no
 * default profile, no `opencli` command at all. (M1.5 already proved daemon
 * routing; M2 proves the action payloads are real.)
 *
 * We import `electron` only here (harness), keeping the library Electron-free.
 */

import { app, BaseWindow, WebContentsView } from 'electron';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createWebContentsLeaseProvider } from '../src/view-provider.js';
import { dispatch } from '../src/actions.js';
import type { CommandFrame, ResultFrame, TargetProvider } from '../src/types.js';
import type { WcContents } from '../src/webcontents-target.js';

const EVIDENCE_DIR =
  process.env.M2_EVIDENCE_DIR ?? resolve(process.cwd(), 'harness/evidence/m2');
const PROGRESS_LOG = resolve(EVIDENCE_DIR, 'progress.log');

/** File-based progress (Electron GUI stdout is unreliable when detached). */
const prog = (msg: string): void => {
  try {
    appendFileSync(PROGRESS_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* best effort */
  }
  process.stdout.write(`[m2] ${msg}\n`);
};

interface Step {
  name: string;
  pass: boolean;
  detail: unknown;
}

const isOk = (r: ResultFrame): r is Extract<ResultFrame, { ok: true }> => r.ok === true;

/** A tiny local site: root page sets a cookie + embeds a CROSS-ORIGIN iframe. */
function startFixtureServer(): Promise<{ rootUrl: string; iframeOrigin: string; close: () => void }> {
  return new Promise((resolveServer) => {
    // The iframe server is a SEPARATE origin (different port) → cross-origin, so
    // the extension's enumerateCrossOriginFrames will emit it (the whole point).
    const iframe = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>child</title><h1>child frame</h1>');
    });
    iframe.listen(0, '127.0.0.1', () => {
      const iport = (iframe.address() as AddressInfo).port;
      const iframeOrigin = `http://127.0.0.1:${iport}`;
      const root = createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          // a real Set-Cookie the page will carry; httpOnly so it proves we read
          // it over CDP (JS document.cookie could not see an httpOnly cookie).
          'Set-Cookie': 'render_m2=proof_value_123; Path=/; HttpOnly; SameSite=Lax',
        });
        res.end(
          `<!doctype html><title>render m2 fixture</title><h1>render m2</h1>` +
            `<iframe src="${iframeOrigin}/child" name="childframe"></iframe>`,
        );
      });
      root.listen(0, '127.0.0.1', () => {
        const rport = (root.address() as AddressInfo).port;
        resolveServer({
          rootUrl: `http://127.0.0.1:${rport}/`,
          iframeOrigin,
          close: () => {
            root.close();
            iframe.close();
          },
        });
      });
    });
  });
}

async function run(provider: TargetProvider, rootUrl: string): Promise<{ steps: Step[]; page: string }> {
  const steps: Step[] = [];
  let n = 0;
  const cmd = (c: Omit<CommandFrame, 'id'>): CommandFrame => ({ id: `m2_${++n}`, ...c });

  // ── navigate to the real local fixture first (single lease minted here) ──────
  prog(`navigate → ${rootUrl}`);
  const nav = await dispatch(provider, cmd({ action: 'navigate', url: rootUrl }));
  if (!isOk(nav) || typeof nav.page !== 'string') {
    throw new Error(`navigate failed: ${JSON.stringify(nav)}`);
  }
  const page = nav.page;
  steps.push({ name: 'navigate', pass: true, detail: { page, data: nav.data } });
  prog(`navigate ok, page=${page}`);

  // ── (1) cdp: a real DOM.enable + DOM.getDocument round-trip ──────────────────
  // Runtime.evaluate is NOT allowlisted (it goes through `exec`), so we use
  // allowlisted methods that return real structured data: DOM.enable then
  // DOM.getDocument.
  prog('cdp DOM.enable');
  await dispatch(provider, cmd({ action: 'cdp', page, cdpMethod: 'DOM.enable' }));
  prog('cdp DOM.getDocument');
  const dom = await dispatch(provider, cmd({ action: 'cdp', page, cdpMethod: 'DOM.getDocument', cdpParams: { depth: 1 } }));
  const domData = isOk(dom) ? (dom.data as { root?: { nodeName?: string; childNodeCount?: number } }) : null;
  const cdpPass = isOk(dom) && dom.page === page && domData?.root?.nodeName === '#document';
  steps.push({
    name: 'cdp:DOM.getDocument',
    pass: cdpPass,
    detail: { page: isOk(dom) ? dom.page : null, rootNodeName: domData?.root?.nodeName, childNodeCount: domData?.root?.childNodeCount },
  });

  // cdp over-allowlist must be rejected (a real reject, through dispatch)
  const denied = await dispatch(provider, cmd({ action: 'cdp', page, cdpMethod: 'Page.navigate', cdpParams: { url: 'http://evil' } }));
  steps.push({
    name: 'cdp:over-allowlist-rejected',
    pass: !denied.ok && denied.error?.includes('not permitted'),
    detail: denied,
  });

  // ── (2) cookies: real httpOnly cookie read over Network.getCookies ───────────
  prog('cookies');
  const cookiesRes = await dispatch(provider, cmd({ action: 'cookies', url: rootUrl }));
  const cookieArr = isOk(cookiesRes) && Array.isArray(cookiesRes.data) ? (cookiesRes.data as Array<Record<string, unknown>>) : [];
  const found = cookieArr.find((c) => c.name === 'render_m2');
  const cookiesPass =
    isOk(cookiesRes) && !('page' in cookiesRes) && found?.value === 'proof_value_123' && found?.httpOnly === true;
  steps.push({
    name: 'cookies',
    pass: cookiesPass,
    detail: { hasPageField: 'page' in cookiesRes, count: cookieArr.length, cookie: found ?? null },
  });

  // ── (3) screenshot: real PNG bytes (magic header + non-trivial size) ─────────
  prog('screenshot');
  const shot = await dispatch(provider, cmd({ action: 'screenshot', page }));
  let pngOk = false;
  let pngInfo: Record<string, unknown> = {};
  if (isOk(shot) && typeof shot.data === 'string' && shot.data.length > 0) {
    const buf = Buffer.from(shot.data, 'base64');
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    const magic = buf.subarray(0, 8).toString('hex');
    pngOk = magic === '89504e470d0a1a0a' && buf.length > 1000 && shot.page === page;
    pngInfo = { magicHex: magic, byteLength: buf.length, base64Length: shot.data.length, page: shot.page };
    // save the real bytes as evidence
    writeFileSync(resolve(EVIDENCE_DIR, 'screenshot.png'), buf);
  }
  steps.push({ name: 'screenshot', pass: pngOk, detail: pngInfo });

  // ── (4) frames: real cross-origin iframe enumerated ──────────────────────────
  prog('frames');
  const framesRes = await dispatch(provider, cmd({ action: 'frames', page }));
  const frameArr = isOk(framesRes) && Array.isArray(framesRes.data) ? (framesRes.data as Array<Record<string, unknown>>) : [];
  const framesPass = isOk(framesRes) && framesRes.page === page && frameArr.length >= 1 && frameArr.every((f) => typeof f.frameId === 'string');
  steps.push({ name: 'frames', pass: framesPass, detail: { page: isOk(framesRes) ? framesRes.page : null, frames: frameArr } });

  for (const s of steps) prog(`step ${s.name}: ${s.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(s.detail).slice(0, 300)}`);
  return { steps, page };
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(PROGRESS_LOG, '');
  prog('main start; awaiting app.whenReady');
  await app.whenReady();
  prog('app ready');

  // The window must COMPOSITE for Page.captureScreenshot to produce a frame, but
  // it must NOT disturb the user's desktop. We park it far off any plausible
  // display and show it there (show:false yields no compositor surface → the
  // screenshot CDP call hangs forever). Off-screen + show is invisible to the user.
  const win = new BaseWindow({ width: 1280, height: 900, show: false, x: -10000, y: -10000 });
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, offscreen: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
  win.showInactive(); // composite without stealing focus; parked at (-10000,-10000)

  let viewClosed = false;
  const provider = createWebContentsLeaseProvider({
    mintView: () => ({
      webContents: view.webContents as unknown as WcContents,
      destroy: () => {
        if (viewClosed) return;
        viewClosed = true;
        try {
          win.contentView.removeChildView(view);
          view.webContents.close();
        } catch {
          /* already gone */
        }
      },
    }),
  });

  const fixture = await startFixtureServer();
  prog(`fixture up: ${fixture.rootUrl}`);
  let summary: Record<string, unknown>;
  try {
    const { steps, page } = await run(provider, fixture.rootUrl);
    const pass = steps.every((s) => s.pass);
    summary = {
      verdict: pass ? 'PASS' : 'FAIL',
      page,
      fixture: { rootUrl: fixture.rootUrl, iframeOrigin: fixture.iframeOrigin },
      steps,
      ts: new Date().toISOString(),
    };
  } catch (err) {
    summary = { verdict: 'FAIL', error: err instanceof Error ? err.stack : String(err), ts: new Date().toISOString() };
  } finally {
    fixture.close();
    await provider.dispose().catch(() => {});
  }

  writeFileSync(resolve(EVIDENCE_DIR, 'verdict.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(`__M2_VERDICT__ ${JSON.stringify(summary)}\n`);
  app.exit(summary.verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[m2-fatal] ${err instanceof Error ? err.stack : String(err)}\n`);
  app.exit(1);
});
