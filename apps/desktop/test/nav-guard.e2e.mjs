/**
 * Deterministic Electron integration test for the navigation guard.
 *
 * Bug being guarded: clicking a result-card link in the agent panel (a json-render
 * Link → <a href>) used to navigate the CHROME WINDOW itself to the external URL,
 * replacing the entire app UI. The fix (apps/desktop/src/main/index.ts `wire()`)
 * adds a `will-navigate` guard + `setWindowOpenHandler` that cancel the nav and
 * call `tabs.create(url)` so the link opens a NEW active browsing tab and the
 * shell stays intact.
 *
 * This test launches the REAL built app (out/main/index.js) under Electron's
 * `--remote-debugging-port`, so the unmodified shipped guard runs. It then:
 *   1. finds the chrome-shell webContents target (the renderer SPA),
 *   2. injects + clicks an external anchor (https://example.org/) inside it,
 *   3. asserts (a) a NEW page target for example.org appeared (new tab), and
 *      (b) the chrome target's URL is UNCHANGED (the shell was NOT replaced).
 *
 *   pnpm --filter @render/desktop test:nav     (build first: pnpm … build)
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');
const mainEntry = join(appDir, 'out', 'main', 'index.js');
const electronBin = require('electron'); // resolves to the platform binary path

const CDP_PORT = Number(process.env.NAV_CDP_PORT ?? 9477);
const EXTERNAL_URL = 'https://example.org/';
const BOOT_TIMEOUT_MS = 25_000;
const TAB_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(s + '\n');

/** GET http://127.0.0.1:CDP_PORT/json/<path> → parsed JSON (no system proxy). */
function cdpHttp(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: CDP_PORT, path: `/json/${path}`, agent: false },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('cdp http timeout')));
  });
}

const isChromeShell = (t) =>
  t.type === 'page' &&
  (t.url.startsWith('file://') || t.url.includes(':5173')) &&
  t.url.includes('index.html');

const pageTargets = (list) => list.filter((t) => t.type === 'page');

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep polling while the endpoint warms up */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

/** Evaluate an expression in a target via its devtools websocket. */
function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params) =>
      new Promise((res) => {
        const mid = ++id;
        pending.set(mid, res);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    ws.on('open', async () => {
      try {
        await send('Runtime.enable', {});
        const r = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        ws.close();
        resolve(r);
      } catch (e) {
        ws.close();
        reject(e);
      }
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result ?? msg.error);
        pending.delete(msg.id);
      }
    });
    ws.on('error', reject);
    setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('cdp evaluate timeout'));
    }, 8000);
  });
}

async function main() {
  log('▶ nav-guard e2e — real built app under Electron CDP');
  log(`  main:     ${mainEntry}`);
  log(`  cdp port: ${CDP_PORT}`);

  const child = spawn(electronBin, [mainEntry, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: appDir,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mainLog = '';
  child.stdout.on('data', (d) => (mainLog += d));
  child.stderr.on('data', (d) => (mainLog += d));

  let failed = null;
  try {
    // 1. wait for the chrome shell target to exist
    const shellBefore = await waitFor(
      async () => {
        const list = await cdpHttp('list');
        return list.find(isChromeShell) ?? null;
      },
      BOOT_TIMEOUT_MS,
      'chrome shell target',
    );
    const shellUrlBefore = shellBefore.url;
    log(`\n  chrome shell target: ${shellUrlBefore}`);

    // settle: let the boot self-test tab(s) appear so we don't miscount
    await sleep(1500);
    const before = pageTargets(await cdpHttp('list'));
    const externalBefore = before.filter((t) => t.url.startsWith(EXTERNAL_URL));
    log(`  page targets before click: ${before.length} (example.org tabs: ${externalBefore.length})`);

    // 2. inject + click an external anchor INSIDE the chrome renderer
    log(`\n  injecting + clicking <a href="${EXTERNAL_URL}"> in the chrome shell …`);
    await cdpEvaluate(
      shellBefore.webSocketDebuggerUrl,
      `(() => { const a=document.createElement('a'); a.href=${JSON.stringify(
        EXTERNAL_URL,
      )}; a.textContent='ext'; document.body.appendChild(a); a.click(); return document.location.href; })()`,
    );

    // 3a. assert a NEW example.org tab/WebContentsView was created
    const newTab = await waitFor(
      async () => {
        const list = pageTargets(await cdpHttp('list'));
        return list.find((t) => t.url.startsWith(EXTERNAL_URL)) ?? null;
      },
      TAB_TIMEOUT_MS,
      'new example.org tab',
    );
    log(`\n  ✓ new tab created → ${newTab.url}  (type=${newTab.type})`);

    // 3b. assert the chrome shell URL is UNCHANGED (shell not replaced)
    await sleep(500);
    const afterList = await cdpHttp('list');
    const shellAfter = afterList.find((t) => t.id === shellBefore.id) ?? afterList.find(isChromeShell);
    const shellUrlAfter = shellAfter ? shellAfter.url : '(chrome target GONE)';
    log(`  chrome shell target after click: ${shellUrlAfter}`);

    const shellIntact = Boolean(shellAfter) && shellUrlAfter === shellUrlBefore;
    const shellNavigatedToExternal =
      Boolean(shellAfter) && shellUrlAfter.startsWith(EXTERNAL_URL);

    log('');
    log(`  assert (a) new example.org tab exists      : ${newTab ? 'YES' : 'NO'}`);
    log(`  assert (b) chrome shell URL unchanged       : ${shellIntact ? 'YES' : 'NO'}`);
    log(`  guard: chrome did NOT navigate to external  : ${!shellNavigatedToExternal ? 'YES' : 'NO'}`);

    if (newTab && shellIntact && !shellNavigatedToExternal) {
      log('\n✅ PASS — external link opened a NEW tab; the app shell was not replaced.');
    } else {
      failed = 'nav guard did not behave as required';
      if (shellNavigatedToExternal)
        log('\n❌ FAIL — the CHROME SHELL navigated to the external URL (app UI replaced).');
      else if (!newTab) log('\n❌ FAIL — no new example.org tab was created.');
      else if (!shellIntact) log('\n❌ FAIL — chrome shell URL changed unexpectedly.');
    }
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
    log(`\n❌ FAIL — ${failed}`);
    log('--- main log tail ---\n' + mainLog.split('\n').slice(-12).join('\n'));
  } finally {
    child.kill('SIGKILL');
    await sleep(300);
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
