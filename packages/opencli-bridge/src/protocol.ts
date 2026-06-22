/**
 * Pure helpers for building `/ext` Result frames + the `hello` registration.
 *
 * Kept side-effect-free so the wire envelope is unit-testable without a socket.
 * Field names here (`id/ok/data/page/error/errorCode`) are the stable contract
 * the spike decoded; opencli validates none of them server-side, so they are the
 * exact surface to track on an opencli bump.
 */

import type { HelloFrame, ResultFrame, StalePageError } from './types.js';

/** opencli daemon contextId we register as (defaultContextId in browser-profiles.json). */
export const DEFAULT_CONTEXT_ID = '3k59e8nw';

/**
 * `hello` fields are advisory — the daemon stores version/compatRange but never
 * gates the hot path on them. We send plausible values; `opencli doctor` only
 * warns on a mismatch, and a daemon/CLI version mismatch force-restarts the
 * daemon (not us), which we recover from by re-sending hello on reconnect.
 */
export function helloFrame(contextId: string): HelloFrame {
  return { type: 'hello', contextId, version: '1.0.19', compatRange: '>=1.7.0' };
}

/** A success Result. `page` is omitted for actions that carry no lease (cookies). */
export function ok(id: string, data: unknown, page?: string): ResultFrame {
  return page !== undefined ? { id, ok: true, data, page } : { id, ok: true, data };
}

/** A failure Result. Optional `errorCode`/`errorHint` mirror the extension. */
export function fail(
  id: string,
  error: string,
  extra: { errorCode?: string; errorHint?: string } = {},
): ResultFrame {
  return { id, ok: false, error, ...extra };
}

/** Map any thrown error to a Result, preserving the stale-page code. */
export function errorToResult(id: string, err: unknown): ResultFrame {
  if (isStalePage(err)) return fail(id, err.message, { errorCode: err.errorCode });
  const message = err instanceof Error ? err.message : String(err);
  return fail(id, message);
}

function isStalePage(err: unknown): err is StalePageError {
  return err instanceof Error && (err as { errorCode?: string }).errorCode === 'stale_page';
}
