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
 * Milestone 1 is single-lease: the bridge owns ONE bridge-only `WebContentsView`,
 * added off-screen (never shown, never inset over the user's tabs), matching the
 * daemon's `windowMode:"background"` commands. Multi-lease / owned windows are the
 * FULL-autonomy follow-up (see packages/opencli-bridge punch-list).
 *
 * Verification is the standalone harness (packages/opencli-bridge/harness), NOT a
 * relaunch of the user's app — this hook is exercised there in isolation.
 */

import { WebContentsView, type BaseWindow } from 'electron';
import {
  createOpencliBridge,
  createWebContentsLeaseProvider,
  RENDER_CONTEXT_ID,
  type BridgeHandle,
} from '@render/opencli-bridge';

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
  if (process.env.RENDER_OPENCLI_BRIDGE !== '1') return null;

  let view: WebContentsView | null = null;
  const provider = createWebContentsLeaseProvider({
    mintView: async () => {
      // Bridge-owned, off-screen view: never added to the visible content rect,
      // so it cannot disturb the user's tabs or window chrome.
      const v = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true },
      });
      view = v;
      deps.window.contentView.addChildView(v);
      v.setBounds({ x: -4000, y: -4000, width: 1280, height: 900 });
      v.setVisible(false);
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
          if (view === v) view = null;
        },
      };
    },
  });

  const profile = renderBridgeProfile();
  const bridge: BridgeHandle = createOpencliBridge({
    provider,
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
