/**
 * E2E proof: a REAL `opencli` browser command drives RENDER's embedded Chromium
 * over CDP — and NOT the user's system Chrome.
 *
 * Why this is the proof that matters: opencli's default browser path is its
 * extension bridge, which drives system Chrome. opencli only uses its direct-CDP
 * client for sites registered as Electron apps. Render now (a) launches with
 * `--remote-debugging-port`, (b) registers itself as the opencli Electron app
 * `render` (apps.yaml + a `render` adapter), and (c) points the agent's
 * OPENCLI_CDP_ENDPOINT at its own port. This test exercises that whole chain
 * with the REAL built app and the REAL opencli binary.
 *
 * Steps:
 *   1. launch the BUILT Render app under an ISOLATED $HOME (temp) so the app's
 *      own opencli-app registration writes to temp/.opencli (no global side
 *      effects), with `--remote-debugging-port=<port>`.
 *   2. find Render's about:blank browsing tab and Page.navigate it to a unique
 *      marker data: URL (so we can assert opencli read THIS browser's tab).
 *   3. run `opencli render get` (HOME=temp, OPENCLI_CDP_ENDPOINT=Render's port,
 *      OPENCLI_CDP_TARGET pinned to the marker) and assert it returns the marker.
 *   4. assert Google Chrome was never launched.
 *
 *   pnpm --filter @render/desktop test:cdp     (builds first)
 *
 * Requires: a built app (out/main/index.js) and `opencli` on PATH.
 */

import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');
const mainEntry = join(appDir, 'out', 'main', 'index.js');
const electronBin = require('electron');

const CDP_PORT = Number(process.env.CDP_E2E_PORT ?? 9344);
const NONCE = 'RENDER-CDP-PROOF-' + CDP_PORT;
const MARKER_URL = `data:text/html,<title>${NONCE}</title><h1>render-embedded-chromium</h1>`;
const BOOT_TIMEOUT_MS = 30_000;
const TAB_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(s + '\n');

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

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* warm-up */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

/** Send one CDP command to a target's page websocket. */
function cdpSend(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.on('open', () => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result ?? msg.error);
        ws.close();
      }
    });
    ws.on('error', reject);
    setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('cdp send timeout'));
    }, 8000);
  });
}

const isShell = (t) => t.type === 'page' && t.url.includes('index.html');
const isBlankTab = (t) => t.type === 'page' && (t.url === 'about:blank' || t.url === '');
const chromeRunning = () => {
  try {
    execSync('pgrep -x "Google Chrome"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

async function main() {
  log('▶ cdp-opencli e2e — opencli drives RENDER Chromium over CDP (not system Chrome)');
  log(`  main:     ${mainEntry}`);
  log(`  cdp port: ${CDP_PORT}`);

  if (chromeRunning()) {
    log('\n⚠ system Google Chrome is already running — the "Chrome stays closed" assertion');
    log('  is weaker. Close Chrome for the strongest proof. Continuing.');
  }
  const chromeWasRunning = chromeRunning();

  const home = mkdtempSync(join(tmpdir(), 'render-cdp-e2e-'));
  log(`  isolated HOME: ${home}`);

  const child = spawn(electronBin, [mainEntry, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: appDir,
    env: {
      ...process.env,
      HOME: home, // app registers render into ${home}/.opencli; opencli reads it too
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mainLog = '';
  child.stdout.on('data', (d) => (mainLog += d));
  child.stderr.on('data', (d) => (mainLog += d));

  let failed = null;
  try {
    // 1. wait for Render's CDP endpoint
    await waitFor(() => cdpHttp('version'), BOOT_TIMEOUT_MS, "Render's CDP endpoint");
    log('\n  ✓ Render CDP endpoint is up');

    // 2. find a browsing tab (about:blank WebContentsView) and navigate it to the marker
    const tab = await waitFor(
      async () => {
        const list = await cdpHttp('list');
        return list.find(isBlankTab) ?? list.find((t) => t.type === 'page' && !isShell(t)) ?? null;
      },
      TAB_TIMEOUT_MS,
      "Render's browsing tab",
    );
    log(`  ✓ found Render browsing tab: ${tab.url || '(blank)'}`);
    await cdpSend(tab.webSocketDebuggerUrl, 'Page.navigate', { url: MARKER_URL });
    await sleep(1200);

    // 3. run the REAL opencli render command against Render's CDP
    log('\n  running: opencli render get  (CDP → Render, target pinned to marker)');
    const out = execSync('opencli render get -f json', {
      env: {
        ...process.env,
        HOME: home,
        OPENCLI_CDP_ENDPOINT: `http://127.0.0.1:${CDP_PORT}`,
        OPENCLI_CDP_TARGET: NONCE,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    log('  opencli output:');
    log(
      out
        .trim()
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n'),
    );
    const parsed = JSON.parse(out);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const readTitle = String(row?.title ?? '');
    const readUrl = String(row?.url ?? '');

    // 4. assertions
    const drovRender = readTitle.includes(NONCE) || readUrl.includes(NONCE);
    const chromeNowRunning = chromeRunning();
    const chromeStayedClosed = chromeWasRunning || !chromeNowRunning;

    log('');
    log(`  assert (a) opencli read RENDER's tab (marker)   : ${drovRender ? 'YES' : 'NO'}`);
    log(`  assert (b) system Chrome not launched by test    : ${chromeStayedClosed ? 'YES' : 'NO'}`);

    if (drovRender && chromeStayedClosed) {
      log('\n✅ PASS — opencli drove Render\'s embedded Chromium over CDP; system Chrome untouched.');
    } else {
      failed = 'opencli did not drive Render over CDP as required';
      if (!drovRender) log('\n❌ FAIL — opencli did not return Render\'s marker tab.');
      if (!chromeStayedClosed) log('\n❌ FAIL — system Chrome was launched.');
    }
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
    log(`\n❌ FAIL — ${failed}`);
    log('--- main log tail ---\n' + mainLog.split('\n').slice(-15).join('\n'));
  } finally {
    child.kill('SIGKILL');
    await sleep(300);
    rmSync(home, { recursive: true, force: true });
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
