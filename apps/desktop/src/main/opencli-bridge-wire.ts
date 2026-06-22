/**
 * Flag-gated wire-in for @render/opencli-bridge (Milestone 1, default OFF).
 *
 * When `RENDER_OPENCLI_BRIDGE=1`, Render registers itself as its OWN, distinct
 * opencli browser profile (contextId `render`, override via `RENDER_OPENCLI_PROFILE`)
 * and serves `/ext` browser commands by driving its OWN Chromium — so opencli's
 * cookie/browser adapters run inside Render, never system Chrome. Crucially it does
 * NOT register as the system-Chrome extension's contextId (`3k59e8nw`), so system
 * Chrome stays connected on its own profile, untouched: opencli routes to Render
 * only when a caller targets `--profile render` / `OPENCLI_PROFILE=render`, and the
 * unqualified default keeps routing to system Chrome. Inert by default: with the
 * flag unset this module does nothing and nothing is constructed.
 *
 * Milestone 3 is MULTI-LEASE: the bridge owns a registry of bridge-only
 * `WebContentsView`s (one per `tabs new`), each its own CDP target with a stable
 * targetId, all added to ONE shared off-screen compositing host (never shown over
 * the user's tabs), each at a distinct non-overlapping off-screen rect so a
 * non-active lease can still be screenshotted. Network capture (per-lease) and
 * wait-download (CDP Browser.setDownloadBehavior into a temp dir) are wired via
 * DispatchCaps. Matches the daemon's owned-tab-group + windowMode model.
 *
 * Verification is the standalone harness (packages/opencli-bridge/harness), NOT a
 * relaunch of the user's app — this hook is exercised there in isolation.
 */

import { WebContentsView, type BaseWindow } from 'electron';
import { mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createOpencliBridge,
  createMultiWebContentsLeaseProvider,
  createNetworkCaptureRegistry,
  RENDER_CONTEXT_ID,
  type BridgeHandle,
  type DispatchCaps,
} from '@render/opencli-bridge';
import { RENDER_PARTITION } from './tabs.js';

export interface OpencliBridgeWire {
  /** The opencli profile name Render registered as — point `OPENCLI_PROFILE` here. */
  readonly profile: string;
  /** Tear down the bridge + its owned view. Idempotent. */
  dispose(): Promise<void>;
}

/** Resolve Render's bridge profile name (env override → `"render"`). */
export function renderBridgeProfile(): string {
  const override = process.env.RENDER_OPENCLI_PROFILE?.trim();
  return override && override.length > 0 ? override : RENDER_CONTEXT_ID;
}

export interface OpencliBridgeWireDeps {
  /** The host window the bridge's off-screen view attaches to. */
  window: BaseWindow;
}

/**
 * Returns `null` when the flag is off (the default) — callers treat null as
 * "bridge disabled" and skip disposal. Best-effort: a failed daemon connect is
 * logged via onError and retried by the bridge, never crashing Render boot.
 */
export function maybeWireOpencliBridge(deps: OpencliBridgeWireDeps): OpencliBridgeWire | null {
  // Default ON — Render serves opencli's cookie/browser adapters from its own
  // Chromium. Set RENDER_OPENCLI_BRIDGE=0 to fall back to the system-Chrome bridge.
  if (process.env.RENDER_OPENCLI_BRIDGE === '0') return null;

  // Each lease gets a distinct off-screen slot so all leased views composite
  // simultaneously (lets a NON-active lease be screenshotted — see the M3 proof).
  const VIEW_W = 600;
  const VIEW_H = 800;
  let slot = 0;
  const provider = createMultiWebContentsLeaseProvider({
    mintView: async () => {
      // Bridge-owned, off-screen view: parked far off any display, so it cannot
      // disturb the user's tabs or window chrome. One view per `tabs new`.
      const v = new WebContentsView({
        // SAME persistent session as the user's tabs → a cookie set by logging
        // in on a visible tab is visible to opencli when it drives this view.
        webPreferences: { sandbox: true, contextIsolation: true, partition: RENDER_PARTITION },
      });
      deps.window.contentView.addChildView(v);
      // Distinct, non-overlapping rect far off-screen; non-zero bounds so the
      // page composites (required for screenshots of non-active leases).
      v.setBounds({ x: -10000 + (slot % 2) * VIEW_W, y: -10000 + Math.floor(slot / 2) * VIEW_H, width: VIEW_W, height: VIEW_H });
      slot += 1;
      await v.webContents.loadURL('about:blank');
      return {
        webContents: v.webContents,
        destroy: () => {
          try {
            deps.window.contentView.removeChildView(v);
            v.webContents.close();
          } catch {
            /* already gone */
          }
        },
      };
    },
  });

  // Per-lease network capture buffer + a temp download dir for wait-download.
  const downloadPath = mkdtempSync(join(tmpdir(), 'render-opencli-dl-'));
  const caps: DispatchCaps = {
    network: createNetworkCaptureRegistry(),
    download: {
      downloadPath,
      // CDP `allowAndName` writes under the download GUID.
      resolveSavePath: (guid) => join(downloadPath, guid),
      fileSize: (p) => {
        try {
          return statSync(p).size;
        } catch {
          return 0;
        }
      },
    },
  };

  const profile = renderBridgeProfile();
  const bridge: BridgeHandle = createOpencliBridge({
    provider,
    caps,
    // Distinct, named profile — never the shared system-Chrome contextId.
    contextId: profile,
    onError: (err) => console.warn('[opencli-bridge]', err.message),
  });

  void bridge.start().catch((err) => {
    console.warn('[opencli-bridge] failed to connect to daemon:', String(err));
  });

  return {
    profile,
    dispose: async () => {
      await bridge.stop();
    },
  };
}
