/**
 * MultiLeaseProvider — Milestone 3's `TargetProvider`, the drop-in replacement
 * for `SingleLeaseProvider` at the seam M1 left.
 *
 * opencli's real browser model is NOT one tab — it is an *owned tab group*: the
 * adapter session can `tabs new` several tabs, `tabs select` between them,
 * `tabs close` one, and `tabs list` enumerates them. Each tab is a distinct CDP
 * `page` target whose `targetId` is STABLE across navigations within that tab
 * (Chrome keeps one page-type target per tab — decoded from the extension's
 * `targetToTab`/`tabToTarget` maps). We reproduce that faithfully: a registry of
 * leases, each its OWN `WebContentsView` + CDP target, keyed by a stable
 * `targetId` that persists across navigations within the lease.
 *
 * Semantics decoded from `extension-v1.0.19/dist/background.js`:
 *   • `page` (a CDP targetId) is the durable lease handle, stable across nav.
 *   • a referenced `page` that is no longer alive → `StalePageError`.
 *   • `tabs new`    → mint a fresh view+lease, return its `page`.
 *   • `tabs select` → mark a lease active (the daemon's active-tab model).
 *   • `tabs close`  → dispose that view+lease (its CDP target disposed too).
 *   • `tabs list`   → enumerate `{index, page, url, title, active}`.
 *   • `windowMode`  → foreground vs background (focus the owned window or not);
 *                     advisory at the provider level (Render parks views
 *                     off-screen and composites without stealing focus — see
 *                     the screenshot compositing note in view-provider.ts).
 *
 * The provider owns lease lifecycle ONLY; the per-view Electron surface is
 * injected (kept structural, no `electron` import) so this stays unit-testable
 * with a fake target factory.
 */

import { StalePageError, type CdpTarget, type TargetProvider } from './types.js';

/** A single owned tab in the group: its CDP target + activation state. */
interface LeaseEntry {
  target: CdpTarget;
  /** Whether this lease is the daemon-model "active" tab (last new/select). */
  active: boolean;
  /** Mint order — used for the stable `index` opencli's `tabs list` returns. */
  ordinal: number;
}

/** Extra surface MultiLeaseProvider exposes beyond `TargetProvider` for `tabs`. */
export interface MultiLeaseProvider extends TargetProvider {
  /** Mint a fresh leased target (the `tabs new` create). */
  mint(): Promise<CdpTarget>;
  /** Mark a lease active by its `page` handle (the `tabs select`). Throws if stale. */
  select(page: string): CdpTarget;
  /** Dispose a single lease by `page` handle (the `tabs close`). Returns the
   *  closed targetId, or undefined if it was already gone. */
  closeLease(page?: string): Promise<string | undefined>;
  /** Enumerate every live lease in mint order, with the active flag. */
  list(): { target: CdpTarget; active: boolean; ordinal: number }[];
}

export interface MultiLeaseDeps {
  /** Mint a fresh CDP target (a new WebContentsView in production). */
  createTarget(): Promise<CdpTarget>;
}

export function createMultiLeaseProvider(deps: MultiLeaseDeps): MultiLeaseProvider {
  // Keyed by stable targetId so lookups by `page` are O(1) and survive nav.
  const leases = new Map<string, LeaseEntry>();
  let ordinalSeq = 0;

  /** Drop any lease whose underlying surface died (closed externally). */
  const reapDead = (): void => {
    for (const [id, entry] of leases) {
      if (!entry.target.isAlive()) leases.delete(id);
    }
  };

  /** The currently-active lease, or the most-recently-minted live one. */
  const activeEntry = (): LeaseEntry | null => {
    reapDead();
    let fallback: LeaseEntry | null = null;
    for (const entry of leases.values()) {
      if (entry.active) return entry;
      fallback = entry;
    }
    return fallback;
  };

  const setActive = (entry: LeaseEntry): void => {
    for (const e of leases.values()) e.active = false;
    entry.active = true;
  };

  const mint = async (): Promise<CdpTarget> => {
    const target = await deps.createTarget();
    await target.attach();
    const entry: LeaseEntry = { target, active: true, ordinal: ordinalSeq++ };
    for (const e of leases.values()) e.active = false;
    leases.set(target.targetId, entry);
    return target;
  };

  const acquire = async (page?: string): Promise<CdpTarget> => {
    reapDead();
    if (page) {
      const entry = leases.get(page);
      // Stale if unknown OR the surface died (mirrors the extension's
      // "Page not found … stale page identity").
      if (!entry || !entry.target.isAlive()) throw new StalePageError(page);
      return entry.target;
    }
    // No page handle → operate on the active lease, minting the first one lazily
    // (the first `navigate` of a session, before any `tabs new`).
    const active = activeEntry();
    if (active) return active.target;
    return mint();
  };

  const select = (page: string): CdpTarget => {
    reapDead();
    const entry = leases.get(page);
    if (!entry || !entry.target.isAlive()) throw new StalePageError(page);
    setActive(entry);
    return entry.target;
  };

  const closeLease = async (page?: string): Promise<string | undefined> => {
    reapDead();
    // No page → close the active lease (matches the extension's `tabs close`
    // with no index/page targeting the lease's preferred tab).
    const entry = page ? leases.get(page) : activeEntry();
    if (!entry) return undefined;
    const closedId = entry.target.targetId;
    const wasActive = entry.active;
    try {
      await entry.target.close();
    } catch {
      /* surface may already be gone */
    }
    leases.delete(closedId);
    // If we closed the active tab, promote the most-recent survivor so the
    // daemon's model still has an active tab to fall back on.
    if (wasActive) {
      const survivor = [...leases.values()].at(-1);
      if (survivor) survivor.active = true;
    }
    return closedId;
  };

  const list = (): { target: CdpTarget; active: boolean; ordinal: number }[] => {
    reapDead();
    return [...leases.values()]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((e) => ({ target: e.target, active: e.active, ordinal: e.ordinal }));
  };

  const current = (): CdpTarget | null => activeEntry()?.target ?? null;

  const dispose = async (): Promise<void> => {
    const all = [...leases.values()];
    leases.clear();
    for (const entry of all) {
      try {
        await entry.target.close();
      } catch {
        /* already gone */
      }
    }
  };

  return { acquire, current, dispose, mint, select, closeLease, list };
}
