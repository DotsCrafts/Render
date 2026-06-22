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
