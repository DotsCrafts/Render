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
