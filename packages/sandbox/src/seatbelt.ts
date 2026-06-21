/**
 * macOS seatbelt (sandbox-exec) profile generation.
 *
 * This is the same OS primitive codex uses for its `workspace-write` sandbox:
 * read + network are allowed, but file writes are confined to an explicit set
 * of roots (the jailed workdir + temp dirs). Paths MUST be real (symlinks
 * resolved) because seatbelt matches against canonical paths — see
 * `resolveWritableRoots`.
 */

import { realpath } from 'node:fs/promises';

/** Roots that are always writable inside the jail (temp dirs). */
const TMP_ROOTS = ['/private/tmp', '/private/var/folders', '/tmp'] as const;

/**
 * Build a `workspace-write`-equivalent seatbelt profile string.
 *
 * @param writableRoots canonical (realpath'd) absolute paths writes are allowed under
 */
export function seatbeltProfile(writableRoots: readonly string[]): string {
  const allows = [...new Set(writableRoots.filter(Boolean))]
    .map((p) => `(allow file-write* (subpath ${JSON.stringify(p)}))`)
    .join('\n');
  return ['(version 1)', '(allow default)', '(deny file-write*)', allows].join('\n');
}

/**
 * Canonicalize a workdir into the full writable-root set for a seatbelt run.
 * Always includes the temp roots so commands can write scratch files.
 */
export async function resolveWritableRoots(workdir: string): Promise<string[]> {
  const real = await realpath(workdir).catch(() => workdir);
  return [real, ...TMP_ROOTS];
}
