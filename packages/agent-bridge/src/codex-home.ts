/**
 * Hook-free CODEX_HOME — protocol-level HITL by default (B2).
 *
 * codex 0.136.0 routes command/file approvals through a local `PermissionRequest`
 * hook in the user's `~/.codex/hooks.json` when one is present, short-circuiting
 * the app-server protocol so the approval never reaches `CodexClient`'s HITL
 * seam — the turn then stalls waiting on the local hook.
 *
 * Render owns the approval UX (the ux confirm/form surfaces), so the bridge can
 * point codex at a private home derived from the user's: the real `auth.json`
 * (the Plane-1 model credential codex already holds) plus `config.toml` with
 * every `[hooks…]` section stripped, and crucially NO `hooks.json`. With no
 * permission hook, codex emits approvals as app-server server-requests → our seam.
 *
 * Best-effort: if the source home can't be read we return null and the caller
 * falls back to codex's default home (the user's hooks then apply).
 *
 * Mirrors apps/desktop/src/main/codex-home.ts so consumers get the same
 * protocol-level HITL without re-implementing it.
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

/**
 * Build a temp CODEX_HOME with the user's auth but no permission hooks.
 * @param sourceHome the home to derive from (defaults to ~/.codex)
 */
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
