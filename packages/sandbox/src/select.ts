/**
 * SandboxProvider factory: e2b when `E2B_API_KEY` is present, else the keyless
 * local-seatbelt default. The seam is identical, so callers (agent-bridge) are
 * agnostic to which sandbox the brain ends up running in.
 */

import type { SandboxProvider } from '@render/protocol';
import { LocalSeatbeltSandbox } from './local-seatbelt.js';
import { E2bSandbox } from './e2b.js';

export interface SelectSandboxOptions {
  /** force a provider regardless of env (mainly for tests) */
  prefer?: 'local-seatbelt' | 'e2b';
  e2b?: { template?: string; timeoutMs?: number; env?: Record<string, string> };
  /** extra seatbelt writable roots (local provider only) — keep NARROW */
  extraWritableRoots?: readonly string[];
}

export function selectSandbox(opts: SelectSandboxOptions = {}): SandboxProvider {
  const apiKey = process.env.E2B_API_KEY;
  const wantE2b = opts.prefer === 'e2b' || (opts.prefer !== 'local-seatbelt' && Boolean(apiKey));

  const local = () =>
    new LocalSeatbeltSandbox(
      opts.extraWritableRoots ? { extraWritableRoots: opts.extraWritableRoots } : {},
    );

  if (wantE2b) {
    if (!apiKey && opts.prefer !== 'e2b') {
      // shouldn't happen, but be explicit about the fallback
      return local();
    }
    return new E2bSandbox({ apiKey, ...opts.e2b });
  }
  return local();
}

/** Human-readable note about which provider selectSandbox() would pick + why. */
export function describeSelection(opts: SelectSandboxOptions = {}): string {
  const apiKey = process.env.E2B_API_KEY;
  if (opts.prefer === 'e2b') return 'e2b (forced)';
  if (opts.prefer === 'local-seatbelt') return 'local-seatbelt (forced)';
  return apiKey ? 'e2b (E2B_API_KEY set)' : 'local-seatbelt (no E2B_API_KEY)';
}
