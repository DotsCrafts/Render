/**
 * Output parsing for opencli runs.
 *
 * opencli prints clean JSON to stdout (the update-check banner goes to stderr),
 * but we still extract defensively: slice from the first bracket to the last
 * matching one so a stray prefix/suffix never breaks a real result.
 */

import type { OpencliExec } from './types.js';

/** opencli's AUTH_REQUIRED exit code (verified against 1.8.4 cookie adapters). */
export const AUTH_REQUIRED_EXIT = 77;

/** opencli's BROWSER_CONNECT exit code (Browser Bridge profile not connected). */
export const BROWSER_CONNECT_EXIT = 69;

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

/** True when a run failed because the site needs a logged-in session. */
export function isAuthRequired(exec: OpencliExec): boolean {
  if (exec.exitCode === AUTH_REQUIRED_EXIT) return true;
  return /AUTH_REQUIRED|Not logged in(?:to)?|Sign in at|Please .*log in/i.test(
    `${exec.stdout}\n${exec.stderr}`,
  );
}

/**
 * True when a run failed because no browser session is connected at all
 * (opencli ≥1.8 routes website cookie adapters through Browser Bridge profiles;
 * a disconnected profile fails with BROWSER_CONNECT before auth is even seen).
 * The remedy is the same as needsLogin: open the site in a Render tab, which
 * both connects the bridge profile and lets the human log in.
 */
export function isBrowserUnavailable(exec: OpencliExec): boolean {
  const text = `${exec.stdout}\n${exec.stderr}`;
  if (/code:\s*BROWSER_CONNECT/i.test(text)) return true;
  return exec.exitCode === BROWSER_CONNECT_EXIT && /browser|profile|chrome/i.test(text);
}

/**
 * Best-effort login URL for a `needsLogin` reply: prefer an explicit URL in the
 * adapter's auth message, else synthesize one from the site's domain.
 */
export function extractLoginUrl(exec: OpencliExec, fallbackDomain?: string): string | undefined {
  const match = `${exec.stdout}\n${exec.stderr}`.match(/https?:\/\/[^\s"')]+/);
  if (match) return match[0];
  return fallbackDomain ? `https://${fallbackDomain}` : undefined;
}
