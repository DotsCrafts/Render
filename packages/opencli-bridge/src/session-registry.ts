/**
 * SessionLeaseRegistry — per-session lease partitioning.
 *
 * opencli sends a unique `session` per run (plus a `surface`), and the real
 * extension keys ALL lease state by `getLeaseKey(session, surface)` =
 * `${surface}\0${encodeURIComponent(session)}`. The bridge used to ignore both
 * fields and share ONE flat lease registry across every caller, which is the
 * root of two audited findings:
 *
 *   • "close-window-nukes-all-leases" — any session's `close-window` disposed
 *     EVERY session's tabs (handleCloseWindow → provider.dispose() → all).
 *   • cross-session hijack — a pageless command resolved against whichever
 *     lease happened to be "active", regardless of who minted it.
 *
 * This registry mirrors the extension's partitioning: one `MultiLeaseProvider`
 * per leaseKey, minted lazily on the first command that names that session.
 * Each partition keeps its OWN active-lease flag (inside its provider), so a
 * pageless acquire resolves against the command's own session. The provider a
 * command receives is partition-scoped: its `dispose()` releases ONLY that
 * session's leases (so `close-window` is session-local), while the registry's
 * `dispose()` still tears down everything (the `bridge.stop()` path).
 *
 * Commands with no/blank `session` route to the surface's DEFAULT partition
 * (empty session part). `encodeURIComponent` of a real, non-empty session is
 * never empty, so the default key cannot collide with a named session.
 *
 * Idle reaping mirrors the extension's alarm model (background.js
 * `resetWindowIdleTimer`/`releaseLease`): every command resets the partition's
 * idle timer; on expiry the partition's leases are released. Defaults match
 * the extension (browser surface 10 min, adapter 30 s), with the same
 * per-session overrides opencli already sends: `idleTimeout` (seconds, > 0)
 * and, for the adapter surface, `siteSession: "persistent"` → never reaped.
 */

import { createMultiLeaseProvider, type MultiLeaseProvider } from './multi-lease.js';
import type { CdpTarget, CommandFrame } from './types.js';

export const LEASE_KEY_SEPARATOR = '\0';

/** Extension parity: adapter-surface sessions idle out after 30 s… */
export const IDLE_TIMEOUT_DEFAULT = 30_000;
/** …browser-surface (interactive) sessions after 10 min… */
export const IDLE_TIMEOUT_INTERACTIVE = 600_000;
/** …and a non-positive timeout means "never reap". */
export const IDLE_TIMEOUT_NONE = -1;

type Surface = 'browser' | 'adapter';

/** The extension's `getCommandSurface`: anything but `adapter` is `browser`. */
const normalizeSurface = (surface: string | undefined): Surface =>
  surface === 'adapter' ? 'adapter' : 'browser';

/**
 * The extension's `getLeaseKey`, extended with the default-partition rule for
 * sessionless commands (the extension rejects those; we serve them from a
 * dedicated partition so bare/legacy callers keep working without being able
 * to touch any named session's leases).
 */
export function getLeaseKey(session: string | undefined, surface: string | undefined): string {
  const name = typeof session === 'string' ? session.trim() : '';
  return `${normalizeSurface(surface)}${LEASE_KEY_SEPARATOR}${name ? encodeURIComponent(name) : ''}`;
}

/** The partition key a Command frame addresses. */
export function leaseKeyForCommand(cmd: Pick<CommandFrame, 'session' | 'surface'>): string {
  return getLeaseKey(cmd.session, cmd.surface);
}

/** The extension's `getSurfaceFromKey`. */
const surfaceOfKey = (key: string): Surface =>
  key.split(LEASE_KEY_SEPARATOR, 1)[0] === 'adapter' ? 'adapter' : 'browser';

export interface SessionLeaseDeps {
  /** Mint a fresh CDP target (a new WebContentsView in production). */
  createTarget(): Promise<CdpTarget>;
  /** Observe partition releases (`'explicit close'` | `'idle timeout'` | `'registry dispose'`). */
  onRelease?(leaseKey: string, reason: string): void;
}

export interface SessionLeaseRegistry {
  /**
   * The partition-scoped provider for this command's leaseKey, minted lazily.
   * Applies the command's idle/lifecycle overrides and resets the partition's
   * idle timer. The returned provider's `dispose()` releases ONLY this
   * partition (session-local `close-window`).
   */
  providerFor(cmd: CommandFrame): MultiLeaseProvider;
  /** Reset the idle timer after a command completes. Never mints a partition. */
  touch(cmd: Pick<CommandFrame, 'session' | 'surface'>): void;
  /** Live partition keys (diagnostics / tests). */
  sessions(): string[];
  /** Tear down EVERY partition — the `bridge.stop()` path. */
  dispose(): Promise<void>;
}

interface Partition {
  /** The raw per-session lease registry (its dispose = close all its targets). */
  inner: MultiLeaseProvider;
  /** What dispatch sees: `inner` with dispose() rebound to release the partition. */
  scoped: MultiLeaseProvider;
  idleTimer: NodeJS.Timeout | null;
  /** `cmd.idleTimeout` (seconds) → ms, extension's sessionTimeoutOverrides. */
  idleTimeoutOverrideMs?: number;
  /** `cmd.siteSession`, extension's sessionLifecycleOverrides (adapter only). */
  lifecycleOverride?: 'persistent' | 'ephemeral';
}

export function createSessionLeaseRegistry(deps: SessionLeaseDeps): SessionLeaseRegistry {
  const partitions = new Map<string, Partition>();

  /** The extension's `getIdleTimeout`, minus the bound-tab case (no borrowed tabs here). */
  const idleTimeoutOf = (key: string, part: Partition): number => {
    if (surfaceOfKey(key) === 'adapter' && part.lifecycleOverride === 'persistent') {
      return IDLE_TIMEOUT_NONE;
    }
    if (part.idleTimeoutOverrideMs !== undefined) return part.idleTimeoutOverrideMs;
    return surfaceOfKey(key) === 'browser' ? IDLE_TIMEOUT_INTERACTIVE : IDLE_TIMEOUT_DEFAULT;
  };

  const clearIdleTimer = (part: Partition): void => {
    if (part.idleTimer) {
      clearTimeout(part.idleTimer);
      part.idleTimer = null;
    }
  };

  const resetIdleTimer = (key: string, part: Partition): void => {
    clearIdleTimer(part);
    const timeout = idleTimeoutOf(key, part);
    if (timeout <= 0) return;
    part.idleTimer = setTimeout(() => {
      void release(key, 'idle timeout');
    }, timeout);
    part.idleTimer.unref?.();
  };

  /** The extension's `releaseLease`: drop the partition + its overrides + timer,
   *  then close its targets. Idempotent — a vanished partition is a no-op. */
  const release = async (key: string, reason: string): Promise<void> => {
    const part = partitions.get(key);
    if (!part) return;
    partitions.delete(key);
    clearIdleTimer(part);
    try {
      await part.inner.dispose();
    } catch {
      /* targets may already be gone */
    }
    deps.onRelease?.(key, reason);
  };

  /** The extension's per-command override capture (handleCommand's preamble). */
  const applyOverrides = (key: string, part: Partition, cmd: CommandFrame): void => {
    if (surfaceOfKey(key) === 'adapter') {
      if (cmd.siteSession === 'persistent') part.lifecycleOverride = 'persistent';
      else if (cmd.siteSession === 'ephemeral') part.lifecycleOverride = 'ephemeral';
    }
    if (typeof cmd.idleTimeout === 'number' && cmd.idleTimeout > 0) {
      part.idleTimeoutOverrideMs = cmd.idleTimeout * 1_000;
    }
  };

  const providerFor = (cmd: CommandFrame): MultiLeaseProvider => {
    const key = leaseKeyForCommand(cmd);
    let part = partitions.get(key);
    if (!part) {
      const inner = createMultiLeaseProvider({ createTarget: deps.createTarget });
      part = {
        inner,
        // Same tab surface as `inner`, but dispose() releases ONLY this
        // partition — so `close-window` cannot touch other sessions' leases.
        scoped: { ...inner, dispose: () => release(key, 'explicit close') },
        idleTimer: null,
      };
      partitions.set(key, part);
    }
    applyOverrides(key, part, cmd);
    resetIdleTimer(key, part);
    return part.scoped;
  };

  const touch = (cmd: Pick<CommandFrame, 'session' | 'surface'>): void => {
    const key = leaseKeyForCommand(cmd);
    const part = partitions.get(key);
    if (part) resetIdleTimer(key, part);
  };

  const sessions = (): string[] => [...partitions.keys()];

  const dispose = async (): Promise<void> => {
    const keys = [...partitions.keys()];
    for (const key of keys) {
      await release(key, 'registry dispose');
    }
  };

  return { providerFor, touch, sessions, dispose };
}
