/**
 * Output parsing for opencli runs.
 *
 * opencli prints clean JSON to stdout (the update-check banner goes to stderr),
 * but we still extract defensively: slice from the first bracket to the last
 * matching one so a stray prefix/suffix never breaks a real result.
 *
 * Auth/browser detection is EXIT-CODE gated: exit 77 (AUTH_REQUIRED) and exit
 * 69 (BROWSER_CONNECT) are authoritative; the text heuristics only run on a
 * non-zero exit. A SUCCESSFUL scrape whose content happens to contain phrases
 * like "Please log in" (ubiquitous in forum threads and page chrome) must
 * never be discarded as a login wall.
 */

import type { OpencliExec } from './types.js';

/** opencli's AUTH_REQUIRED exit code (verified against 1.8.4 cookie adapters). */
export const AUTH_REQUIRED_EXIT = 77;

/** opencli's BROWSER_CONNECT exit code (Browser Bridge profile not connected). */
export const BROWSER_CONNECT_EXIT = 69;

/** The adapter phrases that signal "needs a logged-in session" in output text. */
const AUTH_MESSAGE_RE = /AUTH_REQUIRED|Not logged in(?:to)?|Sign in at|Please .{0,200}log in/i;

/** Synthetic exit the sandbox resolves when it kills a timed-out child. */
const TIMEOUT_EXIT = 124;

/** POSIX "command not found" — opencli itself is missing from PATH. */
const NOT_FOUND_EXIT = 127;

/** CLI-layer rejections that never reached the adapter (no login signal at all). */
const CLI_REJECT_RE =
  /unknown (?:sub)?command|unrecognized (?:sub)?command|no such command|unknown (?:option|flag)|unexpected argument/i;

/**
 * Positive evidence that the adapter's command BODY executed (so the auth gate
 * was already passed) and only its own verify scraper drifted — opencli tags
 * these COMMAND_EXEC (e.g. dianping's "member page rendered but no user_id link
 * found"). Only this evidence may upgrade a failed whoami to "connected";
 * any other unexplained failure (engine misconfig, network, daemon drift —
 * smoke-verified: OpenCLIApp's exit-78 OPENCLI_DAEMON_PORT error) must stay
 * `unknown`, or a broken engine paints every connector as signed-in.
 */
const ADAPTER_DRIFT_RE = /COMMAND_EXEC/i;

export function extractJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to bracket slicing */
  }
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const close = text[start] === '[' ? ']' : '}';
  const end = text.lastIndexOf(close);
  if (end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * True when a run failed because the site needs a logged-in session.
 * Exit 77 is authoritative; the text heuristic requires a non-zero exit
 * (mirrors the desktop-side detector in opencli-auth.ts).
 */
export function isAuthRequired(exec: OpencliExec): boolean {
  if (exec.exitCode === AUTH_REQUIRED_EXIT) return true;
  if (exec.exitCode === 0) return false;
  return AUTH_MESSAGE_RE.test(`${exec.stdout}\n${exec.stderr}`);
}

/**
 * True when a run failed because no browser session is connected at all
 * (opencli ≥1.8 routes website cookie adapters through Browser Bridge profiles;
 * a disconnected profile fails with BROWSER_CONNECT before auth is even seen).
 * The remedy is the same as needsLogin: open the site in a Render tab, which
 * both connects the bridge profile and lets the human log in. Like
 * isAuthRequired, the text branch only runs on a non-zero exit so scraped
 * content can't false-positive a successful run.
 */
export function isBrowserUnavailable(exec: OpencliExec): boolean {
  if (exec.exitCode === 0) return false;
  const text = `${exec.stdout}\n${exec.stderr}`;
  if (/code:\s*BROWSER_CONNECT/i.test(text)) return true;
  return exec.exitCode === BROWSER_CONNECT_EXIT && /browser|profile|chrome/i.test(text);
}

/**
 * Best-effort login URL for a `needsLogin` reply. An embedded URL is only
 * trusted when it sits on the same output line as an auth message, or when its
 * host matches the adapter's domain — the FIRST url anywhere in mixed output
 * is usually scraped data, not a login page. Falls back to synthesizing
 * `https://<domain>` from adapter metadata.
 */
export function extractLoginUrl(exec: OpencliExec, fallbackDomain?: string): string | undefined {
  const urlRe = /https?:\/\/[^\s"')]+/g;
  for (const line of `${exec.stdout}\n${exec.stderr}`.split('\n')) {
    for (const url of line.match(urlRe) ?? []) {
      if (AUTH_MESSAGE_RE.test(line) || hostMatchesDomain(url, fallbackDomain)) return url;
    }
  }
  return fallbackDomain ? `https://${fallbackDomain}` : undefined;
}

/** Outcome of a `whoami --site-session persistent` login-state probe. */
export type WhoamiProbe =
  | { kind: 'connected'; account?: string; detail?: string }
  | { kind: 'disconnected' }
  | { kind: 'unknown'; detail: string };

/**
 * Interpret a `whoami` run per opencli's adapter contract (verified on 1.8.4):
 * the AUTH gate runs BEFORE the command body, so exit 77 / logged_in:false is
 * authoritative "signed out" — while a whoami that fails PAST the gate (verify
 * scraper drift, e.g. dianping's "member page rendered but no user_id link
 * found") means the session is live and only the adapter's own check drifted.
 * Infra failures (bridge down, timeout, missing binary, CLI rejections) are
 * `unknown`, never "disconnected" — a dead daemon must not paint every
 * connector signed-out.
 */
export function parseWhoami(exec: OpencliExec): WhoamiProbe {
  if (exec.exitCode === AUTH_REQUIRED_EXIT) return { kind: 'disconnected' };

  if (exec.exitCode === 0) {
    const parsed = extractJson(exec.stdout);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (row == null || typeof row !== 'object') {
      return { kind: 'unknown', detail: 'whoami returned no JSON' };
    }
    const record = row as Record<string, unknown>;
    if (record.logged_in === true || record.status === 'logged_in') {
      const account = pickAccount(record);
      return { kind: 'connected', ...(account ? { account } : {}) };
    }
    if (record.logged_in === false || record.status === 'logged_out') {
      return { kind: 'disconnected' };
    }
    return { kind: 'unknown', detail: 'whoami JSON has no logged_in field' };
  }

  if (isBrowserUnavailable(exec)) return { kind: 'unknown', detail: 'browser bridge not connected' };
  if (exec.exitCode === TIMEOUT_EXIT) return { kind: 'unknown', detail: 'whoami probe timed out' };
  if (exec.exitCode === NOT_FOUND_EXIT) return { kind: 'unknown', detail: 'opencli not found' };

  const text = `${exec.stdout}\n${exec.stderr}`;
  if (CLI_REJECT_RE.test(text)) {
    return { kind: 'unknown', detail: 'whoami not supported by this adapter' };
  }
  if (AUTH_MESSAGE_RE.test(text)) return { kind: 'disconnected' };

  if (ADAPTER_DRIFT_RE.test(text)) {
    return {
      kind: 'connected',
      detail: `session looks active — whoami verify drifted (${firstLine(text) || `exit ${exec.exitCode}`})`,
    };
  }

  return {
    kind: 'unknown',
    detail: `whoami failed (${firstLine(text) || `exit ${exec.exitCode}`})`,
  };
}

function pickAccount(record: Record<string, unknown>): string | undefined {
  for (const key of ['user_name', 'account', 'nickname', 'username', 'name', 'user_id']) {
    const v = record[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  ).slice(0, 160);
}

function hostMatchesDomain(url: string, domain?: string): boolean {
  if (!domain) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const d = domain.toLowerCase();
    return host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`);
  } catch {
    return false;
  }
}
