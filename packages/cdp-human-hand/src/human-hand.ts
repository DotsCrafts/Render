/**
 * HumanHand — the chromium CDP "hand" (protocol/src/hands.ts).
 *
 * Drives the in-process Chromium tabs the user actually sees via
 * `webContents.debugger` (CDP 1.3). The main process owns the tab → webContents
 * map and injects a resolver; this module owns attach/detach lifecycle, command
 * forwarding, and the local CDP relay seam.
 */

import type { HumanHand } from '@render/protocol';
import { CdpRelay } from './relay.js';
import type { CdpTarget, HumanHandDeps, RelayCommand } from './types.js';

const PROTOCOL_VERSION = '1.3';

export interface HumanHandHandle extends HumanHand {
  /** the live relay (for diagnostics / wiring); null until cdpEndpoint() */
  readonly relay: CdpRelay;
  /** tabIds currently attached over CDP */
  attachedTabs(): string[];
  /** detach everything and close the relay */
  dispose(): Promise<void>;
}

export function createHumanHand(deps: HumanHandDeps): HumanHandHandle {
  const host = deps.relayHost ?? '127.0.0.1';
  const port = deps.relayPort ?? Number(process.env.OPENCLI_CDP_PORT ?? 0);

  // tabId → cleanup for the debugger listeners we registered on attach.
  const attached = new Map<string, () => void>();
  let relayStarted = false;

  const relay = new CdpRelay({
    host,
    port,
    listTargets: () => deps.listTabs().map((t) => ({ tabId: t.tabId, url: t.url, title: t.title })),
    handleCommand: (cmd: RelayCommand) => {
      // The relay resolves per-connection tabIds before this runs; the
      // fallbacks below cover direct callers. On a fresh boot NOTHING is
      // attached yet — fall back to the first live tab (send() auto-attaches)
      // instead of throwing on every first command.
      const tabId = cmd.tabId ?? attached.keys().next().value ?? deps.listTabs()[0]?.tabId;
      if (!tabId) throw new Error('relay: no tab available to target (no tabs open)');
      return send(tabId, cmd.method, cmd.params);
    },
  });

  const requireTarget = (tabId: string): CdpTarget => {
    const target = deps.getTarget(tabId);
    if (!target) throw new Error(`human-hand: unknown tabId "${tabId}"`);
    return target;
  };

  const attach = async (tabId: string): Promise<void> => {
    if (attached.has(tabId)) return; // idempotent
    const target = requireTarget(tabId);
    const dbg = target.debugger;
    if (!dbg.isAttached()) dbg.attach(PROTOCOL_VERSION);

    const onMessage = (_e: unknown, method: string, params: unknown): void => {
      relay.broadcastEvent(method, params, tabId);
    };
    const onDetach = (): void => {
      attached.delete(tabId);
    };
    dbg.on('message', onMessage);
    dbg.on('detach', onDetach);

    attached.set(tabId, () => {
      dbg.removeAllListeners('message');
      dbg.removeAllListeners('detach');
      if (dbg.isAttached()) dbg.detach();
    });
  };

  const send = async <T = unknown>(tabId: string, method: string, params?: object): Promise<T> => {
    await attach(tabId);
    const target = requireTarget(tabId);
    return target.debugger.sendCommand(method, params ?? {}) as Promise<T>;
  };

  const navigate = async (tabId: string, url: string): Promise<void> => {
    await attach(tabId);
    // Drive navigation through CDP (this is the "human hand" moving the tab),
    // falling back to a direct load if the Page domain rejects the URL.
    try {
      await send(tabId, 'Page.navigate', { url });
    } catch {
      await requireTarget(tabId).loadURL(url);
    }
  };

  const openLoginTab = async (site: string, url?: string): Promise<string> => {
    const tabId = await deps.createTab(url);
    await attach(tabId);
    // Best-effort: surface that this tab is a login journey for `site`.
    void site;
    return tabId;
  };

  const cdpEndpoint = async (): Promise<string> => {
    if (!relayStarted) {
      await relay.start();
      relayStarted = true;
    }
    const wsUrl = relay.url;
    if (!wsUrl) throw new Error('human-hand: relay failed to start');
    return wsUrl;
  };

  const dispose = async (): Promise<void> => {
    for (const cleanup of attached.values()) {
      try {
        cleanup();
      } catch {
        /* tab may already be gone */
      }
    }
    attached.clear();
    await relay.close();
    relayStarted = false;
  };

  return {
    attach,
    send,
    navigate,
    openLoginTab,
    cdpEndpoint,
    relay,
    attachedTabs: () => [...attached.keys()],
    dispose,
  };
}
