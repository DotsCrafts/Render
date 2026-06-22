/**
 * Render-managed CODEX_HOME.
 *
 * Render owns the agent's approval UX (the ux confirm/form surfaces in the
 * panel). codex 0.136.0, however, routes command/file approvals through a local
 * `PermissionRequest` hook in the user's `~/.codex/hooks.json` when one is
 * present — short-circuiting the app-server protocol so the approval never
 * reaches our client.
 *
 * To keep approvals flowing into Render's panel we point codex at a private home
 * derived from the user's: real `auth.json` (the Plane-1 model credential codex
 * already holds) and `config.toml` with every `[hooks…]` section stripped, and
 * crucially NO `hooks.json`. With no permission hook, codex emits the approval as
 * an app-server server-request → our HITL seam.
 *
 * Best-effort: if the source home can't be read we return null and the runtime
 * falls back to codex's default home (the user's hooks then apply).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CodexHome {
  path: string;
  cleanup: () => Promise<void>;
}

/** Drop every top-level `[hooks…]` TOML section (incl. its key/value lines). */
export function stripHookSections(toml: string): string {
  const out: string[] = [];
  let inHooks = false;
  for (const lineRaw of toml.split('\n')) {
    if (/^\s*\[/.test(lineRaw)) inHooks = /^\s*\[hooks/.test(lineRaw);
    if (!inHooks) out.push(lineRaw);
  }
  return out.join('\n');
}

export async function prepareCodexHome(sourceHome?: string): Promise<CodexHome | null> {
  const src = sourceHome ?? join(homedir(), '.codex');
  try {
    const auth = await readFile(join(src, 'auth.json'));
    const path = await mkdtemp(join(tmpdir(), 'render-codex-home-'));
    await writeFile(join(path, 'auth.json'), auth);
    try {
      const config = await readFile(join(src, 'config.toml'), 'utf8');
      await writeFile(join(path, 'config.toml'), stripHookSections(config));
    } catch {
      // no config.toml → codex uses its built-in defaults, still hook-free
    }
    return {
      path,
      cleanup: () => rm(path, { recursive: true, force: true }).catch(() => undefined),
    };
  } catch {
    return null;
  }
}
