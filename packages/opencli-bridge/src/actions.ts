/**
 * Action handlers — translate one opencli Command frame into CDP on the leased
 * `CdpTarget`, returning a Result frame.
 *
 * Milestone 1 implemented navigate/exec/close-window/bind. Milestone 2 adds the
 * single-lease action set the opencli `/ext` client reaches for once a page is
 * leased: cdp, cookies, screenshot, frames. Each is backed by the
 * WebContentsView's CDP (`webContents.debugger.sendCommand`) and mirrors the
 * exact Result shape opencli's daemon-client unwraps (verified against the real
 * extension `background.js` + opencli's `browser/page.js`):
 *
 *   • cdp        → raw CDP result; page-scoped.            (allowlisted methods)
 *   • cookies    → ARRAY of cookies; NOT page-scoped.      (client: Array.isArray)
 *   • screenshot → base64 string in `data`; page-scoped.   (client: const b64 = data)
 *   • frames     → ARRAY of cross-origin frames; page-scoped.
 *
 * Tabs/network-capture/wait-download remain M3 (multi-lease) — still stubbed.
 *
 * Every handler is async and pure w.r.t. the bridge: it takes the command + a
 * resolved target and returns a ResultFrame. No socket, no global state.
 */

import { ok, fail } from './protocol.js';
import type { CdpTarget, CommandFrame, ResultFrame, TargetProvider } from './types.js';

const NAV_TIMEOUT_MS = 15_000;
const SETTLE_MS = 800;

/** Resolve the target a command addresses (its `page` lease, or a fresh one). */
async function resolveTarget(provider: TargetProvider, cmd: CommandFrame): Promise<CdpTarget> {
  return provider.acquire(cmd.page);
}

// ── navigate ───────────────────────────────────────────────────────────────────

export async function handleNavigate(
  provider: TargetProvider,
  cmd: CommandFrame,
): Promise<ResultFrame> {
  if (!cmd.url) return fail(cmd.id, 'Missing url');
  if (!(cmd.url.startsWith('http://') || cmd.url.startsWith('https://'))) {
    return fail(cmd.id, 'Blocked URL scheme — only http:// and https:// are allowed');
  }
  const target = await resolveTarget(provider, cmd);

  // Drive navigation over CDP and wait for the load to settle (bounded), then a
  // beat for SPA/redirect chains. A WebContentsView fires Page.frameStoppedLoading
  // reliably (verified in the harness); we accept either signal so the wait never
  // hangs on engines that emit only one of them.
  let timedOut = false;
  const loaded = new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      offLoad();
      offStop();
      resolve();
    };
    const offLoad = target.on('Page.loadEventFired', finish);
    const offStop = target.on('Page.frameStoppedLoading', finish);
    setTimeout(() => {
      timedOut = true;
      finish();
    }, NAV_TIMEOUT_MS);
  });
  await target.send('Page.navigate', { url: cmd.url });
  await loaded;
  await delay(SETTLE_MS);

  const title = await evaluateValue(target, 'document.title');
  const url = await evaluateValue(target, 'location.href');
  return ok(cmd.id, { title, url, timedOut }, target.targetId);
}

// ── exec ─────────────────────────────────────────────────────────────────────

export async function handleExec(
  provider: TargetProvider,
  cmd: CommandFrame,
): Promise<ResultFrame> {
  if (!cmd.code) return fail(cmd.id, 'Missing code');
  const target = await resolveTarget(provider, cmd);

  // opencli `code` is an expression (often an IIFE or a Promise). Mirror the
  // extension's evaluateAsync: run as an expression, await the promise, return
  // the value by value. `data` is the raw JS return value the adapter scrapes.
  const res = await target.send<{
    result: { value: unknown };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>('Runtime.evaluate', {
    expression: cmd.code,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const msg =
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'exec exception';
    return fail(cmd.id, msg, { errorCode: 'exec_exception' });
  }
  return ok(cmd.id, res.result.value, target.targetId);
}

// ── close-window ───────────────────────────────────────────────────────────────

export async function handleCloseWindow(
  provider: TargetProvider,
  cmd: CommandFrame,
): Promise<ResultFrame> {
  await provider.dispose();
  return ok(cmd.id, { closed: true });
}

// ── bind (advisory no-op, as in the spike) ─────────────────────────────────────

export async function handleBind(cmd: CommandFrame): Promise<ResultFrame> {
  // `bind` associates a session/surface with the lease; for a single-lease
  // backend there is nothing to bind. The extension treats it as bookkeeping.
  return ok(cmd.id, { bound: true });
}

// ── cdp ────────────────────────────────────────────────────────────────────

/**
 * Allowlist of raw CDP methods the `cdp` action may forward — copied verbatim
 * from the extension's `CDP_ALLOWLIST` so Render exposes exactly the same surface
 * the daemon-client already relies on (no more, no less). Anything outside it is
 * rejected loudly, so a compromised/curious adapter cannot reach arbitrary CDP
 * (e.g. `Page.navigate`, `Network.*`, `Browser.*`).
 */
export const CDP_ALLOWLIST: ReadonlySet<string> = new Set([
  // Agent DOM context
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.focus',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.scrollIntoViewIfNeeded',
  'DOMSnapshot.captureSnapshot',
  // Native input events
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  // Page metrics & screenshots
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Page.getFrameTree',
  'Page.handleJavaScriptDialog',
  // Runtime.enable needed for CDP attach setup (Runtime.evaluate goes through 'exec')
  'Runtime.enable',
  // Emulation (used by screenshot full-page)
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
]);

export async function handleCdp(
  provider: TargetProvider,
  cmd: CommandFrame,
): Promise<ResultFrame> {
  if (!cmd.cdpMethod) return fail(cmd.id, 'Missing cdpMethod', { errorCode: 'missing_cdp_method' });
  if (!CDP_ALLOWLIST.has(cmd.cdpMethod)) {
    return fail(cmd.id, `CDP method not permitted: ${cmd.cdpMethod}`, {
      errorCode: 'cdp_not_permitted',
    });
  }
  const target = await resolveTarget(provider, cmd);
  // Strip opencli's frame-routing keys the extension only uses to pick a worker
  // target. Single-lease M2 drives one in-process surface, so we forward the
  // remaining params straight to the page session.
  const params = stripFrameRoutingParams(cmd.cdpParams ?? {});
  const data = await target.send(cmd.cdpMethod, params);
  return ok(cmd.id, data, target.targetId);
}

/** opencli adds `frameId`/`sessionId`/`targetUrl` to route a cdp call at a child
 *  frame target. Single-lease has no separate frame targets, so we drop them and
 *  run against the page session (matches the extension's non-frame branch). */
function stripFrameRoutingParams(params: object): object {
  const { frameId, sessionId, targetUrl, ...rest } = params as Record<string, unknown>;
  void frameId;
  void sessionId;
  void targetUrl;
  return rest;
}

// ── cookies ──────────────────────────────────────────────────────────────────

interface WireCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
}

/** Raw `Network.getCookies` cookie (CDP shape). */
interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds, or -1 for a session cookie. */
  expires?: number;
}

/**
 * `cookies` — the extension used `chrome.cookies.getAll({domain|url})`; we
 * replicate it over CDP `Network.getCookies` (scoped by `urls:[url]` when a url
 * is given) and map the CDP shape onto the extension's exact wire shape.
 *
 * The scope guard matches the extension verbatim: refuse to dump ALL cookies —
 * the caller MUST give a `domain` or `url`. The Result is an ARRAY (the client
 * does `Array.isArray(data) ? data : []`) and carries NO `page` field.
 */
export async function handleCookies(
  provider: TargetProvider,
  cmd: CommandFrame,
): Promise<ResultFrame> {
  const domain = typeof cmd.domain === 'string' ? cmd.domain : undefined;
  const url = typeof cmd.url === 'string' ? cmd.url : undefined;
  if (!domain && !url) {
    return fail(
      cmd.id,
      'Cookie scope required: provide domain or url to avoid dumping all cookies',
      { errorCode: 'cookie_scope_required' },
    );
  }
  const target = await resolveTarget(provider, cmd);
  // `Network.getCookies` honours `urls`; with none it returns the cookies visible
  // to the current frame. We pass `urls:[url]` when a url is supplied and then
  // domain-filter to mirror chrome.cookies.getAll({domain}).
  const res = await target.send<{ cookies?: CdpCookie[] }>(
    'Network.getCookies',
    url ? { urls: [url] } : {},
  );
  const all = Array.isArray(res.cookies) ? res.cookies : [];
  const scoped = domain ? all.filter((c) => matchesDomain(c.domain, domain)) : all;
  const data: WireCookie[] = scoped.map(toWireCookie);
  // NO page field — the extension's handleCookies omits it and the client reads
  // the array directly.
  return ok(cmd.id, data);
}

function matchesDomain(cookieDomain: string, wanted: string): boolean {
  const cd = cookieDomain.replace(/^\./, '').toLowerCase();
  const w = wanted.replace(/^\./, '').toLowerCase();
  return cd === w || cd.endsWith(`.${w}`) || w.endsWith(`.${cd}`);
}

function toWireCookie(c: CdpCookie): WireCookie {
  const wire: WireCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
  };
  // chrome.cookies exposes `expirationDate` (absent for session cookies); CDP
  // uses `expires` with -1 meaning session. Map it so the shape matches.
  if (typeof c.expires === 'number' && c.expires > 0) wire.expirationDate = c.expires;
  return wire;
}

// ── screenshot ─────────────────────────────────────────────────────────────────

/**
 * `screenshot` — `Page.captureScreenshot` → base64. The client does
 * `const base64 = await sendCommand('screenshot', …)` and writes it to disk, so
 * `data` MUST be the raw base64 STRING (not an object). png by default; jpeg
 * carries an optional quality. Page-scoped.
 */
export async function handleScreenshot(
  provider: TargetProvider,
  cmd: CommandFrame,
): Promise<ResultFrame> {
  const target = await resolveTarget(provider, cmd);
  const format = cmd.format === 'jpeg' ? 'jpeg' : 'png';
  const params: { format: string; quality?: number } = { format };
  if (format === 'jpeg' && typeof cmd.quality === 'number') {
    params.quality = Math.max(0, Math.min(100, cmd.quality));
  }
  const res = await target.send<{ data: string }>('Page.captureScreenshot', params);
  return ok(cmd.id, res.data, target.targetId);
}

// ── frames ─────────────────────────────────────────────────────────────────────

interface CdpFrame {
  id: string;
  url?: string;
  unreachableUrl?: string;
  name?: string;
}
interface CdpFrameNode {
  frame: CdpFrame;
  childFrames?: CdpFrameNode[];
}
interface CdpFrameTree {
  frameTree?: CdpFrameNode;
}
interface WireFrame {
  index: number;
  frameId: string;
  url: string;
  name: string;
}

/**
 * `frames` — `Page.getFrameTree` → the extension's cross-origin frame
 * enumeration. Same-origin children are recursed THROUGH (the agent reaches them
 * via the main execution context), only origin-distinct frames are emitted, each
 * `{index, frameId, url, name}`. Result is an ARRAY (client: `Array.isArray`),
 * page-scoped.
 */
export async function handleFrames(
  provider: TargetProvider,
  cmd: CommandFrame,
): Promise<ResultFrame> {
  const target = await resolveTarget(provider, cmd);
  const tree = await target.send<CdpFrameTree>('Page.getFrameTree', {});
  return ok(cmd.id, enumerateCrossOriginFrames(tree), target.targetId);
}

function frameUrlOf(frame: CdpFrame | undefined): string {
  return frame?.url || frame?.unreachableUrl || '';
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Mirror the extension's `enumerateCrossOriginFrames` exactly. */
function enumerateCrossOriginFrames(tree: CdpFrameTree): WireFrame[] {
  const frames: WireFrame[] = [];
  const collect = (node: CdpFrameNode | undefined, accessibleOrigin: string | null): void => {
    for (const child of node?.childFrames ?? []) {
      const frame = child.frame;
      const url = frameUrlOf(frame);
      const frameOrigin = originOf(url);
      if (accessibleOrigin && frameOrigin && frameOrigin === accessibleOrigin) {
        collect(child, frameOrigin);
        continue;
      }
      frames.push({ index: frames.length, frameId: frame.id, url, name: frame.name || '' });
    }
  };
  const rootUrl = frameUrlOf(tree.frameTree?.frame);
  collect(tree.frameTree, originOf(rootUrl));
  return frames;
}

// ── stubs (M3+: multi-lease) ─────────────────────────────────────────────────

/**
 * Structured stubs for the multi-lease action set (tabs, network-capture,
 * wait-download). Each returns a loud, correlated failure so an adapter that
 * depends on it surfaces a real error instead of timing out. These are the M3
 * punch-list (multi-lease provider / owned tabs / network capture).
 */
export async function handleStub(cmd: CommandFrame): Promise<ResultFrame> {
  return fail(cmd.id, `Action not implemented (multi-lease, M3): ${cmd.action}`, {
    errorCode: 'not_implemented',
    errorHint: 'opencli-bridge single-lease covers navigate/exec/close-window/bind/cdp/cookies/screenshot/frames',
  });
}

// ── dispatch ───────────────────────────────────────────────────────────────────

export async function dispatch(
  provider: TargetProvider,
  cmd: CommandFrame,
): Promise<ResultFrame> {
  switch (cmd.action) {
    case 'navigate':
      return handleNavigate(provider, cmd);
    case 'exec':
      return handleExec(provider, cmd);
    case 'close-window':
      return handleCloseWindow(provider, cmd);
    case 'bind':
      return handleBind(cmd);
    case 'cdp':
      return handleCdp(provider, cmd);
    case 'cookies':
      return handleCookies(provider, cmd);
    case 'screenshot':
      return handleScreenshot(provider, cmd);
    case 'frames':
      return handleFrames(provider, cmd);
    case 'tabs':
    case 'network-capture-start':
    case 'network-capture-read':
    case 'wait-download':
      return handleStub(cmd);
    default:
      return fail(cmd.id, `Unknown action: ${cmd.action}`, { errorCode: 'unknown_action' });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

async function evaluateValue(target: CdpTarget, expression: string): Promise<unknown> {
  const res = await target.send<{ result: { value: unknown } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return res.result.value;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
