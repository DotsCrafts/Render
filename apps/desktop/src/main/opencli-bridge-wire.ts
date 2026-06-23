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
 * Milestone 3 is MULTI-LEASE: the bridge owns a registry of leases (one per
 * `tabs new`), each its own CDP target with a stable targetId. Each lease is a
 * REAL, VISIBLE Render tab minted through the TabManager — NOT an off-screen
 * phantom view. This is load-bearing for interactive flows like login: when
 * opencli runs `<site> login` it opens the login page in a tab the user can SEE
 * and complete (scan a QR, type a password); the cookie lands in the shared
 * `persist:render` session, so the agent's subsequent opencli commands (same
 * session) are authenticated. "Render 是浏览器" — the agent drives real tabs.
 * Network capture (per-lease) and wait-download (CDP Browser.setDownloadBehavior
 * into a temp dir) are wired via DispatchCaps.
 *
 * (Tradeoff vs M3's off-screen views: a NON-active lease is `setVisible(false)`
 * and may not composite, so screenshotting a background lease can be blank —
 * acceptable; the active lease, which is what login/interaction needs, is
 * always visible. The standalone harness still exercises the off-screen path.)
 */

import type { WebContents } from 'electron';
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
import type { TabGroupInfo } from '@render/protocol';
import { bindDefaultProfile } from './opencli-profile-bind.js';

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

/**
 * The slice of TabManager the bridge needs: register its group, mint visible
 * grouped tabs, reach their webContents, and close them. Kept structural so the
 * wire stays decoupled (TabManager satisfies it).
 */
export interface BridgeTabHost {
  ensureGroup(info: { id: string; label: string; color: string }): void;
  create(url?: string, opts?: { activate?: boolean; groupId?: string }): string;
  getTarget(id: string): WebContents | undefined;
  close(id: string): void;
}

export interface OpencliBridgeWireDeps {
  /** Render's tab manager — the bridge mints its owned tab group through it. */
  tabs: BridgeTabHost;
  /**
   * The CURRENT agent conversation's tab group, read at mint time. New lease tabs
   * join whichever conversation is active when they're minted (new group ⟺ new
   * conversation), so a conversation switch routes subsequent agent tabs to the
   * new group. Defaults to the original single `agent` group when unset, keeping
   * the pre-conversation behavior as the degenerate case.
   */
  activeGroup?: () => TabGroupInfo;
}

/** Fallback group when no conversation owner is wired — the original behavior. */
const AGENT_GROUP = { id: 'agent', label: 'Agent', color: '#7c93ff' } as const;

/**
 * Returns `null` when the flag is off (the default) — callers treat null as
 * "bridge disabled" and skip disposal. Best-effort: a failed daemon connect is
 * logged via onError and retried by the bridge, never crashing Render boot.
 */
export function maybeWireOpencliBridge(deps: OpencliBridgeWireDeps): OpencliBridgeWire | null {
  // Default ON — Render serves opencli's cookie/browser adapters from its own
  // Chromium. Set RENDER_OPENCLI_BRIDGE=0 to fall back to the system-Chrome bridge.
  if (process.env.RENDER_OPENCLI_BRIDGE === '0') return null;

  // Each lease is a REAL, VISIBLE Render tab in the CURRENT conversation's tab
  // group. `tabs new` (incl. the lazy first lease of a `<site> login`) opens an
  // active tab the user can SEE and interact with — so login QR/password works —
  // and the page shares the user's `persist:render` session, so the cookie it
  // sets authenticates the agent's later opencli commands. The group is read at
  // MINT time, so tabs minted after a conversation switch join the new group.
  const groupOf = deps.activeGroup ?? ((): TabGroupInfo => AGENT_GROUP);
  deps.tabs.ensureGroup(groupOf());
  const provider = createMultiWebContentsLeaseProvider({
    mintView: async () => {
      const group = groupOf();
      // ensure the group is registered so its label/color are known to snapshots,
      // even if this is the first tab the conversation mints.
      deps.tabs.ensureGroup(group);
      const id = deps.tabs.create('about:blank', { activate: true, groupId: group.id });
      const webContents = deps.tabs.getTarget(id);
      if (!webContents) throw new Error('bridge: minted tab has no webContents');
      return {
        webContents,
        destroy: () => deps.tabs.close(id),
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

  // Once connected, make Render the daemon's DEFAULT profile so every opencli
  // command (agent sandbox, skills, the user's terminal) routes to Render's own
  // browser with no OPENCLI_PROFILE needed — the root fix for "none selected"
  // ambiguity. Bind after connect so we never become default-but-unreachable.
  let restoreProfile: () => void = () => {};
  void bridge
    .start()
    .then(() => {
      restoreProfile = bindDefaultProfile(profile);
    })
    .catch((err) => {
      console.warn('[opencli-bridge] failed to connect to daemon:', String(err));
    });

  return {
    profile,
    dispose: async () => {
      restoreProfile(); // hand the default back to system Chrome
      await bridge.stop();
    },
  };
}
