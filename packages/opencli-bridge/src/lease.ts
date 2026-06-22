/**
 * SingleLeaseProvider — Milestone 1's `TargetProvider`.
 *
 * opencli's browser bridge holds a *tab lease*: the first `navigate` mints a tab,
 * the daemon caches its `page` (CDP targetId), and every later command in that
 * adapter session echoes the same `page` back. The slice the spike proved is the
 * single-lease case (`google search`, `dianping search`): one tab, reused across
 * navigate → exec → exec → close-window.
 *
 * This provider leases exactly ONE `CdpTarget` from an injected factory and
 * reuses it. Multi-lease (`tabs new|select|close`, owned windows) is explicitly
 * out of scope here — see the punch-list. Keeping it a separate small class means
 * the multi-lease provider can be a drop-in replacement behind `TargetProvider`.
 */

import { StalePageError, type CdpTarget, type TargetProvider } from './types.js';

export interface SingleLeaseDeps {
  /** Mint a fresh CDP target (a new WebContentsView in production). */
  createTarget(): Promise<CdpTarget>;
}

export function createSingleLeaseProvider(deps: SingleLeaseDeps): TargetProvider {
  let leased: CdpTarget | null = null;

  const live = (): CdpTarget | null => {
    if (leased && !leased.isAlive()) leased = null;
    return leased;
  };

  const mint = async (): Promise<CdpTarget> => {
    const target = await deps.createTarget();
    await target.attach();
    leased = target;
    return target;
  };

  const acquire = async (page?: string): Promise<CdpTarget> => {
    const existing = live();
    if (page) {
      // opencli is reusing a lease it was handed. In single-lease M1 the only
      // valid `page` is our current target's id; anything else is stale.
      if (existing && existing.targetId === page) return existing;
      throw new StalePageError(page);
    }
    // No page handle → first command of a session: reuse a live lease or mint one.
    return existing ?? mint();
  };

  const current = (): CdpTarget | null => live();

  const dispose = async (): Promise<void> => {
    if (leased) {
      try {
        await leased.close();
      } catch {
        /* target may already be gone */
      }
      leased = null;
    }
  };

  return { acquire, current, dispose };
}
