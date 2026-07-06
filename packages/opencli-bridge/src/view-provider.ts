/**
 * createWebContentsLeaseProvider — wires Render's `WebContentsView` factory into
 * a single-lease `TargetProvider` for the bridge.
 *
 * The main process knows how to mint a `WebContentsView` (off-screen / inset)
 * and add it to the window; it passes us a `mintView` that returns the view's
 * `webContents` plus a `destroy` callback. We turn each into a CDP-backed
 * `CdpTarget` and hand the lot to `createSingleLeaseProvider`.
 *
 * In Milestone 1 this leases ONE view; multi-lease (owned windows / tab groups)
 * swaps in a multi-lease provider behind the same `TargetProvider` seam.
 */

import { createSingleLeaseProvider } from './lease.js';
import { createMultiLeaseProvider, type MultiLeaseProvider } from './multi-lease.js';
import { createSessionLeaseRegistry, type SessionLeaseRegistry } from './session-registry.js';
import { createWebContentsTarget, type WcContents } from './webcontents-target.js';
import type { TargetProvider } from './types.js';

export interface MintedView {
  /** The new view's live webContents. */
  webContents: WcContents;
  /** Remove the view from the window + close its webContents. */
  destroy: () => void;
}

export interface WebContentsLeaseDeps {
  /** Mint a fresh, bridge-owned WebContentsView and return its handle. */
  mintView: () => Promise<MintedView> | MintedView;
}

export function createWebContentsLeaseProvider(deps: WebContentsLeaseDeps): TargetProvider {
  return createSingleLeaseProvider({
    createTarget: async () => {
      const view = await deps.mintView();
      return createWebContentsTarget({
        webContents: view.webContents,
        destroyView: view.destroy,
      });
    },
  });
}

/**
 * createMultiWebContentsLeaseProvider — Milestone 3's drop-in replacement.
 *
 * Mints a FRESH `WebContentsView` per lease (each `tabs new`), each its own CDP
 * target with a stable targetId, into the same shared off-screen compositing
 * host window. The provider owns the lease registry; `mintView` owns the
 * Electron surface (kept structural here).
 *
 * ── Multi-view screenshot compositing approach (M2 QA flag carried) ──────────
 * We do NOT scale the single parked `showInactive()` window to N windows (that
 * blows up per-display GPU surfaces and churns focus/z-order). Instead:
 *
 *   • ONE shared off-screen host `BaseWindow`, shown once via `showInactive()`
 *     (parked far off any display) so its compositor is live but invisible and
 *     never steals focus.
 *   • Each lease is a child `WebContentsView` of that host, given a DISTINCT,
 *     non-overlapping off-screen rect with non-zero bounds — so EVERY leased
 *     view composites simultaneously, regardless of z-order.
 *
 * Because each view has its OWN `webContents` and its OWN CDP page target,
 * `Page.captureScreenshot` renders that page's own surface — so a NON-active
 * lease can be screenshotted without bringing it to front. This is the
 * load-bearing property M3's proof asserts (screenshot a non-active lease).
 *
 * The host placement/sizing is the `mintView` caller's job (it owns electron);
 * this provider only requires that `mintView` returns a view whose webContents
 * composites. See `apps/desktop/src/main/opencli-bridge-wire.ts` for the wiring.
 */
export function createMultiWebContentsLeaseProvider(
  deps: WebContentsLeaseDeps,
): MultiLeaseProvider {
  return createMultiLeaseProvider({
    createTarget: async () => {
      const view = await deps.mintView();
      return createWebContentsTarget({
        webContents: view.webContents,
        destroyView: view.destroy,
      });
    },
  });
}

/**
 * createSessionWebContentsLeaseProvider — the multi-lease provider above,
 * PARTITIONED per opencli session (leaseKey = `${surface}\0${session}`, the
 * extension's getLeaseKey). Each session gets its own tab group registry with
 * its own active-lease flag, minted lazily on the session's first command; a
 * session's `close-window` (and its idle timeout) releases only that
 * session's tabs, while the registry's `dispose()` — the `bridge.stop()`
 * path — still tears everything down.
 */
export function createSessionWebContentsLeaseProvider(
  deps: WebContentsLeaseDeps & { onRelease?: (leaseKey: string, reason: string) => void },
): SessionLeaseRegistry {
  return createSessionLeaseRegistry({
    createTarget: async () => {
      const view = await deps.mintView();
      return createWebContentsTarget({
        webContents: view.webContents,
        destroyView: view.destroy,
      });
    },
    onRelease: deps.onRelease,
  });
}
