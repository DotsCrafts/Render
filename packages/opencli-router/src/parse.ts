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
 * Best-effort login URL for a `needsLogin` reply: prefer an explicit URL in the
 * adapter's auth message, else synthesize one from the site's domain.
 */
export function extractLoginUrl(exec: OpencliExec, fallbackDomain?: string): string | undefined {
  const match = `${exec.stdout}\n${exec.stderr}`.match(/https?:\/\/[^\s"')]+/);
  if (match) return match[0];
  return fallbackDomain ? `https://${fallbackDomain}` : undefined;
}
