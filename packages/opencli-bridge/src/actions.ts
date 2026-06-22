/**
 * Action handlers — translate one opencli Command frame into CDP on the leased
 * `CdpTarget`, returning a Result frame.
 *
 * Milestone 1 fully implements the three actions `opencli google search`
 * exercises end-to-end (navigate, exec, close-window). The rest (cdp, cookies,
 * screenshot, tabs, frames, bind) are structured stubs that return a clear,
 * non-crashing failure so an adapter that reaches for them fails loudly rather
 * than hanging — each carries a TODO and is enumerated in the punch-list.
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

// ── stubs (M2+) ─────────────────────────────────────────────────────────────

/**
 * Structured stubs. Each returns a loud, correlated failure so an adapter that
 * depends on it surfaces a real error instead of timing out. Implementing them is
 * the FULL-autonomy punch-list (see README / final report).
 */
export async function handleStub(cmd: CommandFrame): Promise<ResultFrame> {
  // TODO(M2 cdp):        allowlist + target.send(cmd.cdpMethod, cmd.cdpParams)
  // TODO(M2 cookies):    session.cookies.get({ domain/url }) — scope-required guard
  // TODO(M2 screenshot): Page.captureScreenshot → { data, format }
  // TODO(M3 tabs):       multi-lease provider: new | select | close | list
  // TODO(M3 frames):     Page.getFrameTree → cross-origin frame enumeration
  return fail(cmd.id, `Action not implemented in Milestone 1: ${cmd.action}`, {
    errorCode: 'not_implemented',
    errorHint: 'opencli-bridge M1 covers navigate/exec/close-window/bind only',
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
    case 'cookies':
    case 'screenshot':
    case 'tabs':
    case 'frames':
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
