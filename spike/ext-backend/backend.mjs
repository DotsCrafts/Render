/**
 * SPIKE — opencli "Browser Bridge" backend impersonator.
 *
 * Proves Architecture Option A: a NON-extension WebSocket client we control can
 * register with the opencli daemon's /ext socket as the active browser profile,
 * then serve real opencli browser-strategy commands (navigate / exec / cdp /
 * cookies / screenshot) by driving a Chromium WE control over CDP — never the
 * user's system Chrome.
 *
 * It connects OUT to ws://127.0.0.1:19825/ext (the daemon is a WS *server*; the
 * extension — and now us — is the WS *client*). It speaks the exact wire
 * protocol decoded from the extension's background.js:
 *   hello  : {type:"hello", contextId, version, compatRange}
 *   Command: {id, action, session, surface, page?, ...actionFields}   daemon -> us
 *   Result : {id, ok, data, page} | {id, ok:false, error, errorCode?} us -> daemon
 *
 * The CDP target we drive is a tab inside a dedicated "Google Chrome for Testing"
 * launched with --remote-debugging-port and a throwaway --user-data-dir. In a
 * real Render build this becomes a WebContentsView via webContents.debugger.
 *
 * Throwaway. No mocks: every frame logged here is the real daemon traffic.
 */
import { WebSocket } from 'ws';
import CDP from 'chrome-remote-interface';
import fs from 'node:fs';

const DAEMON_WS_URL = 'ws://127.0.0.1:19825/ext';
const CDP_PORT = Number(process.env.SPIKE_CDP_PORT || 19333);
const CONTEXT_ID = process.env.SPIKE_CONTEXT_ID || '3k59e8nw'; // matches browser-profiles.json defaultContextId
const FRAME_LOG = process.env.SPIKE_FRAME_LOG || './frames.ndjson';

const frameLog = fs.createWriteStream(FRAME_LOG, { flags: 'a' });
function logFrame(dir, obj) {
  const ts = new Date().toISOString();
  const rec = { ts, dir, ...obj };
  // truncate huge data (screenshots / page html) for the console + ndjson
  const printable = JSON.stringify(rec, (k, v) =>
    typeof v === 'string' && v.length > 600 ? v.slice(0, 600) + `…[+${v.length - 600} chars]` : v,
  );
  frameLog.write(printable + '\n');
  console.log(`[${dir}] ${printable.slice(0, 900)}`);
}

// ── CDP target management (our controlled Chromium) ──────────────────────────
// We keep ONE leased page target. `page` (targetId) in the protocol == CDP targetId.
let leasedTargetId = null;
const sessions = new Map(); // targetId -> CDP client attached to that target

async function listPageTargets() {
  const targets = await CDP.List({ port: CDP_PORT });
  return targets.filter((t) => t.type === 'page');
}

async function ensureLeasedTarget() {
  if (leasedTargetId) {
    const still = (await listPageTargets()).some((t) => t.id === leasedTargetId);
    if (still) return leasedTargetId;
    leasedTargetId = null;
  }
  // Create a fresh tab WE own (about:blank) in our Chromium.
  const { id } = await CDP.New({ port: CDP_PORT, url: 'about:blank' });
  leasedTargetId = id;
  console.log(`[spike] leased fresh CDP target ${id} in OUR Chromium (port ${CDP_PORT})`);
  return id;
}

async function clientFor(targetId) {
  let client = sessions.get(targetId);
  if (client) return client;
  client = await CDP({ port: CDP_PORT, target: targetId });
  await client.Page.enable().catch(() => {});
  await client.Runtime.enable().catch(() => {});
  sessions.set(targetId, client);
  return client;
}

// resolve which CDP target a command addresses: cmd.page if given+alive, else lease
async function resolveTarget(cmd) {
  if (cmd.page) {
    const alive = (await listPageTargets()).some((t) => t.id === cmd.page);
    if (alive) {
      leasedTargetId = cmd.page;
      return cmd.page;
    }
    // stale page identity — mirror the extension's behaviour
    const err = new Error(`Page not found: ${cmd.page} — stale page identity`);
    err.stale = true;
    throw err;
  }
  return ensureLeasedTarget();
}

function ok(id, data, page) {
  return { id, ok: true, data, ...(page !== undefined && { page }) };
}
function fail(id, error, extra = {}) {
  return { id, ok: false, error, ...extra };
}

// ── action handlers ──────────────────────────────────────────────────────────
const CDP_ALLOWLIST = new Set([
  'Accessibility.enable', 'Accessibility.getFullAXTree', 'DOM.enable', 'DOM.getDocument',
  'DOM.getBoxModel', 'DOM.getContentQuads', 'DOM.focus', 'DOM.querySelector',
  'DOM.querySelectorAll', 'DOM.scrollIntoViewIfNeeded', 'DOMSnapshot.captureSnapshot',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Page.getFrameTree',
  'Page.handleJavaScriptDialog', 'Runtime.enable',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride',
]);

async function handleNavigate(cmd) {
  if (!cmd.url) return fail(cmd.id, 'Missing url');
  if (!(cmd.url.startsWith('http://') || cmd.url.startsWith('https://')))
    return fail(cmd.id, 'Blocked URL scheme -- only http:// and https:// are allowed');
  const targetId = await resolveTarget(cmd);
  const client = await clientFor(targetId);
  let timedOut = false;
  const loadP = new Promise((resolve) => {
    const done = () => resolve();
    client.Page.loadEventFired(done);
    setTimeout(() => { timedOut = true; resolve(); }, 15000);
  });
  await client.Page.navigate({ url: cmd.url });
  await loadP;
  // settle a beat for SPA/redirect chains
  await new Promise((r) => setTimeout(r, 800));
  const { result: titleR } = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
  const { result: urlR } = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
  return ok(cmd.id, { title: titleR.value, url: urlR.value, timedOut }, targetId);
}

async function handleExec(cmd) {
  if (!cmd.code) return fail(cmd.id, 'Missing code');
  const targetId = await resolveTarget(cmd);
  const client = await clientFor(targetId);
  // opencli code is an *expression* (often an IIFE or a promise). Mirror the
  // extension's evaluateAsync: awaitPromise + returnByValue, run as expression.
  const res = await client.Runtime.evaluate({
    expression: cmd.code,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const msg = res.exceptionDetails.exception?.description
      || res.exceptionDetails.text || 'exec exception';
    return fail(cmd.id, msg);
  }
  return ok(cmd.id, res.result.value, targetId);
}

async function handleCdp(cmd) {
  if (!cmd.cdpMethod) return fail(cmd.id, 'Missing cdpMethod');
  if (!CDP_ALLOWLIST.has(cmd.cdpMethod))
    return fail(cmd.id, `CDP method not permitted: ${cmd.cdpMethod}`);
  const targetId = await resolveTarget(cmd);
  const client = await clientFor(targetId);
  const params = cmd.cdpParams ?? {};
  const data = await client.send(cmd.cdpMethod, params);
  return ok(cmd.id, data, targetId);
}

async function handleCookies(cmd) {
  if (!cmd.domain && !cmd.url)
    return fail(cmd.id, 'Cookie scope required: provide domain or url to avoid dumping all cookies');
  // Use a target to call Network.getCookies (mirrors chrome.cookies.getAll scope).
  const targetId = await ensureLeasedTarget();
  const client = await clientFor(targetId);
  const arg = {};
  if (cmd.url) arg.urls = [cmd.url];
  const { cookies } = await client.send('Network.getCookies', arg);
  let filtered = cookies;
  if (cmd.domain) filtered = cookies.filter((c) => c.domain.includes(cmd.domain.replace(/^\./, '')));
  const data = filtered.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expires,
  }));
  return ok(cmd.id, data); // cookies result has no `page` field (matches extension)
}

async function handleScreenshot(cmd) {
  const targetId = await resolveTarget(cmd);
  const client = await clientFor(targetId);
  const { data } = await client.Page.captureScreenshot({ format: cmd.format === 'jpeg' ? 'jpeg' : 'png', quality: cmd.quality });
  return ok(cmd.id, { data, format: cmd.format ?? 'png' }, targetId);
}

async function handleFrames(cmd) {
  const targetId = await resolveTarget(cmd);
  const client = await clientFor(targetId);
  const { frameTree } = await client.Page.getFrameTree();
  return ok(cmd.id, [], targetId); // top-frame only; cross-origin enumeration not needed for proof
}

async function handleTabs(cmd) {
  if (cmd.op === 'list') {
    const targets = await listPageTargets();
    const data = targets.map((t, i) => ({ index: i, page: t.id, url: t.url, title: t.title, active: t.id === leasedTargetId }));
    return ok(cmd.id, data);
  }
  if (cmd.op === 'new') {
    const { id } = await CDP.New({ port: CDP_PORT, url: cmd.url || 'about:blank' });
    leasedTargetId = id;
    return ok(cmd.id, { url: cmd.url }, id);
  }
  return fail(cmd.id, `tabs op not implemented in spike: ${cmd.op}`);
}

async function dispatch(cmd) {
  switch (cmd.action) {
    case 'navigate': return handleNavigate(cmd);
    case 'exec': return handleExec(cmd);
    case 'cdp': return handleCdp(cmd);
    case 'cookies': return handleCookies(cmd);
    case 'screenshot': return handleScreenshot(cmd);
    case 'frames': return handleFrames(cmd);
    case 'tabs': return handleTabs(cmd);
    case 'close-window': {
      // Release our lease; close the owned tab in our Chromium.
      if (leasedTargetId) { try { await CDP.Close({ port: CDP_PORT, id: leasedTargetId }); } catch {} leasedTargetId = null; }
      return ok(cmd.id, { closed: true });
    }
    case 'bind': return ok(cmd.id, { bound: true }); // no-op for spike
    default: return fail(cmd.id, `Unknown action: ${cmd.action}`);
  }
}

// ── WS client to the daemon's /ext ────────────────────────────────────────────
function connect() {
  // Set a chrome-extension:// origin so we pass verifyClient even if it ever
  // tightens. Node ws sends no Origin by default (also passes), but be explicit.
  const ws = new WebSocket(DAEMON_WS_URL, {
    headers: { Origin: 'chrome-extension://spikebackendimpersonatoraaaaaaaa' },
  });

  ws.on('open', () => {
    const hello = { type: 'hello', contextId: CONTEXT_ID, version: '1.0.19', compatRange: '>=1.7.0' };
    logFrame('TX', hello);
    ws.send(JSON.stringify(hello));
    console.log('[spike] hello sent — we are now the daemon profile', CONTEXT_ID);
  });

  ws.on('message', async (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw.toString()); } catch { return; }
    logFrame('RX', cmd);
    let result;
    try {
      result = await dispatch(cmd);
    } catch (err) {
      result = fail(cmd.id, err instanceof Error ? err.message : String(err),
        err?.stale ? { errorCode: 'stale_page' } : {});
    }
    logFrame('TX', result);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  });

  ws.on('close', () => { console.log('[spike] /ext closed'); process.exit(0); });
  ws.on('error', (e) => console.error('[spike] ws error', e.message));
  // respond to daemon heartbeat pings automatically (ws lib auto-pongs)
}

console.log(`[spike] backend starting. CDP port=${CDP_PORT} contextId=${CONTEXT_ID}`);
connect();
