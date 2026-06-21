/**
 * @render/sandbox — the sandbox hand.
 *
 * One `SandboxProvider` seam (from @render/protocol) with two implementations:
 *   - LocalSeatbeltSandbox: default, keyless, macOS seatbelt jail (runs today)
 *   - E2bSandbox:           cross-end, remote e2b sandbox (E2B_API_KEY)
 * Pick one with selectSandbox().
 */

export { LocalSeatbeltSandbox } from './local-seatbelt.js';
export type { LocalSeatbeltOptions } from './local-seatbelt.js';
export { E2bSandbox } from './e2b.js';
export type { E2bOptions } from './e2b.js';
export { selectSandbox, describeSelection } from './select.js';
export type { SelectSandboxOptions } from './select.js';
export { seatbeltProfile, resolveWritableRoots } from './seatbelt.js';

// Re-export the contract types for convenience.
export type {
  SandboxProvider,
  SandboxProcess,
  SandboxSpawnOptions,
  ExecResult,
} from '@render/protocol';
