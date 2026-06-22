/**
 * Detect when the AGENT's own opencli command failed because the target site
 * needs a logged-in session — so Render can surface the `login` HITL surface
 * instead of letting the agent silently fall back to a public source.
 *
 * The agent runs opencli as a normal sandbox command (a codex commandExecution),
 * NOT through the OpencliRouter, so its `needsLogin` mapping never fires. opencli
 * signals the condition itself: exit code 77 (AUTH_REQUIRED) with a message like
 *   "dianping search … requires login — sign in to dianping.com in this profile"
 * We read that off the completed command item and recover the site to log into.
 */

import type { CodexItem } from '@render/protocol';

/** opencli's AUTH_REQUIRED exit code (matches @render/opencli-router parse.ts). */
const AUTH_REQUIRED_EXIT = 77;

const AUTH_TEXT =
  /AUTH_REQUIRED|requires login|requires a logged-in|not logged ?in|please .*log in|sign in (?:at|to)/i;

/** opencli global flags that precede the <site> token and carry a value. */
const VALUE_FLAGS = new Set(['--profile', '-f', '--format']);

export interface OpencliAuthNeed {
  /** the opencli adapter alias to log into, e.g. "dianping" */
  site: string;
  /** best-effort login URL pulled from the adapter's message (cosmetic) */
  loginUrl?: string;
}

/**
 * Returns the site that needs login when `item` is a completed opencli command
 * that failed with an auth-required signal, else null.
 */
export function detectOpencliAuthNeed(item: CodexItem): OpencliAuthNeed | null {
  const command = typeof item.command === 'string' ? item.command : '';
  const site = parseOpencliSite(command);
  if (!site) return null;

  const output = collectOutput(item);
  const authByExit = item.exitCode === AUTH_REQUIRED_EXIT;
  const authByText = AUTH_TEXT.test(output);
  if (!authByExit && !authByText) return null;

  const urlMatch = output.match(/https?:\/\/[^\s"')]+/);
  return { site, ...(urlMatch ? { loginUrl: urlMatch[0] } : {}) };
}

/** Pull the adapter alias out of a shell-wrapped `opencli <site> …` command. */
export function parseOpencliSite(command: string): string | null {
  const idx = command.search(/\bopencli\b/);
  if (idx < 0) return null;
  const tokens = command
    .slice(idx)
    .replace(/['"]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(1); // drop the `opencli` token itself

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('-')) {
      if (VALUE_FLAGS.has(tok)) i += 1; // skip the flag's value too
      continue;
    }
    // first non-flag token is the site/adapter alias
    return /^[a-z][\w-]*$/i.test(tok) ? tok : null;
  }
  return null;
}

function collectOutput(item: CodexItem): string {
  const parts = [item.aggregatedOutput, item.stdout, item.stderr];
  return parts.filter((p) => typeof p === 'string').join('\n');
}
