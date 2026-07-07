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
 * Milestone 3 adds the MULTI-LEASE action set, backed by a `MultiLeaseProvider`
 * (registry of leases, each its own CDP target with a stable targetId):
 *
 *   • tabs new    → mint view+lease; data:{url}, page-scoped (client reads .page).
 *   • tabs select → activate a lease; data:{selected:true}, page-scoped.
 *   • tabs close  → dispose a lease; data:{closed:<targetId>}, NOT page-scoped.
 *   • tabs list   → ARRAY of {index,page,url,title,active}; NOT page-scoped.
 *   • network-capture-start → data:{started:true}, page-scoped.
 *   • network-capture-read  → ARRAY of capture entries (drains), page-scoped.
 *   • wait-download         → downloadResult object; NOT page-scoped.
 *
 * Every handler is async and pure w.r.t. the bridge: it takes the command + a
 * resolved target and returns a ResultFrame. No socket. Multi-lease capabilities
 * (network capture buffer, download config) are threaded through an optional
 * `DispatchCaps` so single-lease callers (M1/M2 tests) stay unchanged.
 */

import { ok, fail } from './protocol.js';
import type { CdpTarget, CommandFrame, ResultFrame, TargetProvider } from './types.js';
import type { MultiLeaseProvider } from './multi-lease.js';
import type { NetworkCaptureRegistry } from './network-capture.js';
import { waitForDownload, type WaitDownloadDeps } from './download.js';

/**
 * Optional multi-lease capabilities. When absent, the multi-lease actions fail
 * loudly (as in M2) — a single-lease provider has no `tabs`/capture surface.
 */
export interface DispatchCaps {
  /** Per-lease network capture buffer (Network domain). */
  network?: NetworkCaptureRegistry;
  /** Download routing config (CDP Browser.setDownloadBehavior target dir etc.). */
  download?: WaitDownloadDeps;
}

/** Type guard: does this provider expose the multi-lease tab surface? */
function isMultiLease(p: TargetProvider): p is MultiLeaseProvider {
  return (
    typeof (p as Partial<MultiLeaseProvider>).mint === 'function' &&
    typeof (p as Partial<MultiLeaseProvider>).list === 'function'
  );
}

const NAV_TIMEOUT_MS = 15_000;
const SETTLE_MS = 800;
/**
 * Cap on wait-download's caller-supplied timeout. The bridge serializes every
 * command through one FIFO, so a single long download wait would block every
 * other CLI client; the cap sits BELOW the bridge's 45s dispatch deadline so
 * the graceful `{downloaded:false, state:'interrupted'}` shape always wins
 * over the queue-level result-unknown timeout failure.
 */
const WAIT_DOWNLOAD_MAX_MS = 40_000;

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
  const { title, url, timedOut } = await navigateTarget(target, cmd.url);
  return ok(cmd.id, { title, url, timedOut }, target.targetId);
}

/**
 * Drive a CDP navigation on a target and wait for the load to settle (bounded),
 * then a beat for SPA/redirect chains. A WebContentsView fires
 * Page.frameStoppedLoading reliably (verified in the harness); we accept either
 * signal so the wait never hangs on engines that emit only one of them. Shared
 * by `navigate` and `tabs new` (which opens a tab AT a url).
 */
async function navigateTarget(
  target: CdpTarget,
  url: string,
): Promise<{ title: unknown; url: unknown; timedOut: boolean }> {
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
  await target.send('Page.navigate', { url });
  await loaded;
  await delay(SETTLE_MS);
  const title = await evaluateValue(target, 'document.title');
  const href = await evaluateValue(target, 'location.href');
  return { title, url: href, timedOut };
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

// ── tabs (multi-lease) ───────────────────────────────────────────────────────

interface WireTab {
  index: number;
  page: string | undefined;
  url: string;
  title: string;
  active: boolean;
}

/** Best-effort url/title for a lease's target (page may not have loaded yet). */
async function tabIdentity(target: CdpTarget): Promise<{ url: string; title: string }> {
  try {
    const url = (await evaluateValue(target, 'location.href')) as string;
    const title = (await evaluateValue(target, 'document.title')) as string;
    return { url: typeof url === 'string' ? url : '', title: typeof title === 'string' ? title : '' };
  } catch {
    return { url: '', title: '' };
  }
}

/**
 * `tabs` — owned tab-group lifecycle. `cmd.op` selects new|select|close|list
 * (matches the extension's `handleTabs`). Requires a multi-lease provider; a
 * single-lease provider has no tab group, so it fails loudly (unchanged M2).
 */
export async function handleTabs(
  provider: TargetProvider,
  cmd: CommandFrame,
): Promise<ResultFrame> {
  if (!isMultiLease(provider)) {
    return fail(cmd.id, 'tabs requires the multi-lease provider', {
      errorCode: 'not_implemented',
      errorHint: 'wire createMultiLeaseProvider into the bridge to enable tabs/owned-window semantics',
    });
  }
  const op = typeof cmd.op === 'string' ? cmd.op : 'list';
  switch (op) {
    case 'new': {
      if (cmd.url !== undefined) {
        const u = String(cmd.url);
        if (!(u.startsWith('http://') || u.startsWith('https://'))) {
          return fail(cmd.id, 'Blocked URL scheme — only http:// and https:// are allowed');
        }
      }
      const target = await provider.mint();
      // Navigate the new tab if a url was given (the extension opens the tab AT url).
      if (cmd.url !== undefined) {
        await navigateTarget(target, String(cmd.url));
      }
      // page-scoped: client reads result.page as the new tab's handle.
      return ok(cmd.id, { url: cmd.url ?? '' }, target.targetId);
    }
    case 'select': {
      const target =
        typeof cmd.page === 'string'
          ? provider.select(cmd.page)
          : selectByIndex(provider, cmd.index);
      return ok(cmd.id, { selected: true }, target.targetId);
    }
    case 'close': {
      const page =
        typeof cmd.page === 'string'
          ? cmd.page
          : typeof cmd.index === 'number'
            ? provider.list()[cmd.index]?.target.targetId
            : undefined;
      const closed = await provider.closeLease(page);
      // NOT page-scoped; client reads result.closed.
      return ok(cmd.id, { closed });
    }
    case 'list':
    default: {
      const leases = provider.list();
      const tabs: WireTab[] = [];
      for (let i = 0; i < leases.length; i++) {
        const { target, active } = leases[i];
        const { url, title } = await tabIdentity(target);
        tabs.push({ index: i, page: target.targetId, url, title, active });
      }
      // NOT page-scoped; client does Array.isArray(result) ? result : [].
      return ok(cmd.id, tabs);
    }
  }
}

function selectByIndex(provider: MultiLeaseProvider, index: unknown): CdpTarget {
  const leases = provider.list();
  const entry = typeof index === 'number' ? leases[index] : undefined;
  if (!entry) throw new Error(`Page is not in the automation container (index ${String(index)})`);
  return provider.select(entry.target.targetId);
}

// ── network-capture (multi-lease, per-lease buffer) ──────────────────────────

export async function handleNetworkCaptureStart(
  provider: TargetProvider,
  cmd: CommandFrame,
  caps: DispatchCaps,
): Promise<ResultFrame> {
  if (!caps.network) return unsupportedCapture(cmd);
  const target = await resolveTarget(provider, cmd);
  const pattern = typeof cmd.pattern === 'string' ? cmd.pattern : '';
  await caps.network.start(target, pattern);
  return ok(cmd.id, { started: true }, target.targetId);
}

export async function handleNetworkCaptureRead(
  provider: TargetProvider,
  cmd: CommandFrame,
  caps: DispatchCaps,
): Promise<ResultFrame> {
  if (!caps.network) return unsupportedCapture(cmd);
  const target = await resolveTarget(provider, cmd);
  // ARRAY (client: Array.isArray) — drains the buffer (extension parity).
  return ok(cmd.id, caps.network.read(target), target.targetId);
}

/** The extension reports an unimplemented capture as an "unknown action" the
 *  client classifies as unsupported (page.js `isUnsupportedNetworkCaptureError`). */
function unsupportedCapture(cmd: CommandFrame): ResultFrame {
  return fail(cmd.id, `Unknown action: ${cmd.action} (network-capture unsupported)`, {
    errorCode: 'unknown_action',
  });
}

// ── wait-download (multi-lease) ──────────────────────────────────────────────

export async function handleWaitDownload(
  provider: TargetProvider,
  cmd: CommandFrame,
  caps: DispatchCaps,
): Promise<ResultFrame> {
  if (!caps.download) {
    return fail(cmd.id, 'wait-download requires download routing config', {
      errorCode: 'not_implemented',
      errorHint: 'pass DispatchCaps.download (CDP Browser.setDownloadBehavior dir)',
    });
  }
  const target = await resolveTarget(provider, cmd);
  const pattern = typeof cmd.pattern === 'string' ? cmd.pattern : '';
  const timeoutMs = Math.min(
    typeof cmd.timeoutMs === 'number' ? cmd.timeoutMs : 30_000,
    WAIT_DOWNLOAD_MAX_MS,
  );
  const result = await waitForDownload(target, caps.download, pattern, timeoutMs);
  // NOT page-scoped (extension handler carries no page).
  return ok(cmd.id, result);
}

// ── dispatch ───────────────────────────────────────────────────────────────────

export async function dispatch(
  provider: TargetProvider,
  cmd: CommandFrame,
  caps: DispatchCaps = {},
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
      return handleTabs(provider, cmd);
    case 'network-capture-start':
      return handleNetworkCaptureStart(provider, cmd, caps);
    case 'network-capture-read':
      return handleNetworkCaptureRead(provider, cmd, caps);
    case 'wait-download':
      return handleWaitDownload(provider, cmd, caps);
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
