/**
 * Bind opencli's DEFAULT browser profile to Render at startup.
 *
 * opencli routes browser/cookie commands to a profile resolved (in order) from
 * `--profile` / `OPENCLI_PROFILE` / `browser-profiles.json:defaultContextId`.
 * Relying only on injecting `OPENCLI_PROFILE=render` into the agent sandbox is
 * fragile: a skill, a subshell, or the user's own terminal can drop the env and
 * fall back to whatever `defaultContextId` happens to be — and with the system
 * Chrome bridge also connected the daemon reports "none selected".
 *
 * The root fix (per the product model "Render IS the browser"): while Render is
 * running, MAKE Render the default profile in `browser-profiles.json`, so EVERY
 * opencli invocation reaches Render's own browser with no env needed. On
 * shutdown we restore the previous default so a terminal `opencli` returns to
 * the system Chrome bridge once Render quits.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROFILES_PATH = join(homedir(), '.opencli', 'browser-profiles.json');

interface ProfilesFile {
  version?: number;
  aliases?: Record<string, string>;
  defaultContextId?: string;
}

function read(): ProfilesFile {
  try {
    if (!existsSync(PROFILES_PATH)) return {};
    const parsed = JSON.parse(readFileSync(PROFILES_PATH, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ProfilesFile) : {};
  } catch {
    return {};
  }
}

function write(data: ProfilesFile): void {
  // Preserve version/aliases; only defaultContextId is ours to drive.
  const next: ProfilesFile = { version: 1, aliases: {}, ...data };
  if (next.defaultContextId === undefined) delete next.defaultContextId;
  writeFileSync(PROFILES_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Make `contextId` the daemon's default profile. Returns a restore fn that puts
 * the previous default back — call it on shutdown. Best-effort: a write failure
 * is logged and yields a no-op restore (never crashes Render boot).
 */
export function bindDefaultProfile(contextId: string): () => void {
  const before = read();
  const previous = before.defaultContextId;
  if (previous === contextId) return () => {}; // already ours — nothing to do/restore
  try {
    write({ ...before, defaultContextId: contextId });
  } catch (err) {
    console.warn('[opencli-profile] failed to bind default profile:', String(err));
    return () => {};
  }
  return () => {
    try {
      const now = read();
      // Don't clobber a default someone else set after us — only restore if we
      // are still the default.
      if (now.defaultContextId !== contextId) return;
      write({ ...now, defaultContextId: previous });
    } catch {
      /* best effort on shutdown */
    }
  };
}
