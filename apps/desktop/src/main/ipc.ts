/**
 * IPC broker — wires the protocol RenderApi channels to the trusted hands.
 *
 * The renderer is untrusted display: it only ever speaks these channels. Each
 * `invoke` handler maps directly onto a protocol method; `emit` channels push
 * the AgentEvent stream and TabState snapshots back. Shapes are taken verbatim
 * from @render/protocol so the real bridge is drop-in.
 */

import { ipcMain, type WebContents } from 'electron';
import {
  IPC,
  type AgentEvent,
  type TabState,
  type UxResult,
  type CodexProviderConfig,
} from '@render/protocol';
import type { HumanHandHandle } from '@render/cdp-human-hand';
import { CHROME_IPC } from '../shared/chrome-channels.js';
import type { TabManager } from './tabs.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { CodexProvider } from './codex-provider.js';
import type { PagesStore } from './pages-store.js';
import type { UxPage } from './ux-server.js';

export interface IpcDeps {
  /** the chrome renderer that receives emit() events */
  chrome: WebContents;
  tabs: TabManager;
  agent: AgentRuntime;
  humanHand: HumanHandHandle;
  /** codex provider/auth manager (Phase A) */
  codex: CodexProvider;
  /** saved render-pages store (Delta 3) */
  pages: PagesStore;
}

export interface IpcBroker {
  emitAgent: (event: AgentEvent) => void;
  emitTabs: (snapshot: TabState[]) => void;
  dispose: () => void;
}

const MAX_EVENT_LOG = 500;

export function registerIpc(deps: IpcDeps): IpcBroker {
  const { chrome, tabs, agent, humanHand, codex, pages } = deps;

  // Durable event stream: the renderer holds events in React state, which is
  // wiped on any reload (HMR, crash, accidental navigation). Buffer them here in
  // the main process and replay via getState() so a reload restores the stream.
  const eventLog: AgentEvent[] = [];

  const emitAgent = (event: AgentEvent): void => {
    eventLog.push(event);
    if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
    if (!chrome.isDestroyed()) chrome.send(IPC.agentEvent, event);
  };
  const emitTabs = (snapshot: TabState[]): void => {
    if (!chrome.isDestroyed()) chrome.send(IPC.tabsChanged, snapshot);
  };

  // Agent-facing handlers reject into promises the renderer fires-and-forgets
  // (useRenderState voids every action), so a bare rejection is invisible: the
  // user's prompt echoes into the feed and then… nothing, forever. Convert
  // rejections into visible feed events instead — an error card plus a failed
  // turn_completed so the busy indicator always resets — then swallow them
  // (nothing upstream can act on the throw).
  const guarded =
    <A extends unknown[]>(fn: (...args: A) => unknown) =>
    async (...args: A): Promise<unknown> => {
      try {
        return await fn(...args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitAgent({ kind: 'error', message });
        emitAgent({ kind: 'turn_completed', status: 'failed' });
        return undefined;
      }
    };

  // Resolved-surface memory (reload survival): AgentPanel tracks which blocking
  // cards were answered in component state, which a renderer reload wipes —
  // replaying the raw event log alone would re-arm already-answered confirm /
  // login cards. Record every resolution here and hand the ids back via
  // getState() so the replay can seed the resolved map.
  const resolvedUxIds = new Set<string>();

  // Reopened saved pages each run their own long-lived ux server. Own the
  // handles here so (a) reopening the same page twice replaces its prior server
  // instead of stacking two, (b) closing the page's tab disposes its server, and
  // (c) window close (broker.dispose) reaps everything instead of leaking node
  // processes. (Agent-delivered pages are tracked by the runtime, not here.)
  const reopenedPages = new Map<string, UxPage>();
  const reopenedPageTabs = new Map<string, string>(); // tabId → page id
  const unsubscribeTabClose = tabs.onTabClose((tabId) => {
    const pageId = reopenedPageTabs.get(tabId);
    if (!pageId) return;
    reopenedPageTabs.delete(tabId);
    reopenedPages.get(pageId)?.dispose();
    reopenedPages.delete(pageId);
  });

  const handlers: Record<string, (...args: never[]) => unknown> = {
    [IPC.submitPrompt]: guarded((_e: unknown, text: string) => agent.submit(text)),
    [IPC.steerTurn]: guarded((_e: unknown, text: string) => agent.steer(text)),
    [IPC.cancelTurn]: guarded(() => agent.cancel()),
    [IPC.resolveUx]: guarded((_e: unknown, id: string, result: UxResult) => {
      resolvedUxIds.add(id);
      return agent.resolveUx(id, result);
    }),
    // new conversation ⟺ new tab group: fresh codex thread + the next group.
    [IPC.newConversation]: () => agent.newConversation(),
    // (agent runtime methods are async; ipcMain.handle awaits the returned promise)

    [IPC.tabNavigate]: (_e, payload: { tabId: string; url: string }) =>
      tabs.navigate(payload.tabId, payload.url),
    [IPC.tabCreate]: (_e, url?: string) => ({ tabId: tabs.create(url) }),
    [IPC.tabClose]: (_e, tabId: string) => tabs.close(tabId),
    [IPC.tabActivate]: (_e, tabId: string) => tabs.activate(tabId),
    [IPC.setPanelWidth]: (_e, width: number) => tabs.setPanelWidth(width),
    [IPC.setPanelOpen]: (_e, open: boolean) => tabs.setPanelOpen(open),
    [IPC.setOverlay]: (_e, hidden: boolean) => tabs.setContentHidden(hidden),
    [IPC.getState]: () => ({
      tabs: tabs.snapshot(),
      events: eventLog.slice(),
      resolvedUxIds: [...resolvedUxIds],
    }),

    // saved render-pages (Delta 3) — persist a spec, list the gallery, reopen live.
    [IPC.savePage]: (_e, id: string) => pages.save(id),
    [IPC.listPages]: () => pages.list(),
    [IPC.openPage]: async (_e, id: string) => {
      const page = pages.reopen(id);
      if (!page) return false;
      // Dedupe per page id: a second reopen replaces the prior server (and drops
      // any stale tab mapping so an old tab's close can't kill the new server).
      reopenedPages.get(id)?.dispose();
      reopenedPages.set(id, page);
      for (const [tabId, pid] of reopenedPageTabs) {
        if (pid === id) reopenedPageTabs.delete(tabId);
      }
      const url = await page.whenReady();
      if (!url) {
        page.dispose();
        if (reopenedPages.get(id) === page) reopenedPages.delete(id);
        return false;
      }
      const tabId = tabs.openUrl(url);
      reopenedPageTabs.set(tabId, id);
      return true;
    },
    // Delta 5: pull a saved page back into the conversation, seeded with its spec,
    // so the agent can emit a new version (render-page → v n+1). Guarded like the
    // other agent entry points — this submit rejects in MAIN, where no renderer
    // catch could ever see it.
    [IPC.askPage]: guarded((_e: unknown, id: string, instruction: string) => {
      const rec = pages.get(id);
      if (!rec) return;
      const prompt =
        `Modify this interactive page ("${rec.title}"). Here is its current ` +
        `json-render spec:\n\n\`\`\`json\n${rec.specJson}\n\`\`\`\n\n` +
        `Change requested: ${instruction.trim() || 'improve it'}\n\n` +
        `Write the updated spec and re-run \`render-page\` (allow: ${rec.allow || 'none'}).`;
      return agent.submit(prompt);
    }),

    // codex provider/auth — each mutation returns the fresh status so the
    // renderer re-renders. OAuth opens the auth URL in a Render tab (never the
    // system browser), so Plane-1 login stays inside Render.
    [IPC.codexStatus]: () => codex.getStatus(),
    [IPC.codexSetProvider]: (_e, p: CodexProviderConfig) => {
      codex.setProvider(p);
      return codex.getStatus();
    },
    [IPC.codexLoginApiKey]: async (_e, apiKey: string) => {
      await codex.loginWithApiKey(apiKey);
      return codex.getStatus();
    },
    [IPC.codexLoginOAuth]: async () => {
      await codex.loginWithOAuth((url: string) => tabs.openUrl(url));
      return codex.getStatus();
    },
    [IPC.codexLogout]: () => {
      codex.logout();
      return codex.getStatus();
    },

    [CHROME_IPC.back]: (_e, tabId: string) => tabs.goBack(tabId),
    [CHROME_IPC.forward]: (_e, tabId: string) => tabs.goForward(tabId),
    [CHROME_IPC.reload]: (_e, tabId: string) => tabs.reload(tabId),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler as (e: Electron.IpcMainInvokeEvent, ...a: unknown[]) => unknown);
  }

  // expose the relay endpoint eagerly so the value is observable in logs/devtools
  void humanHand.cdpEndpoint().then((url) => {
    console.log(`[render] CDP relay listening at ${url}`);
  });

  return {
    emitAgent,
    emitTabs,
    dispose: () => {
      unsubscribeTabClose();
      for (const page of reopenedPages.values()) page.dispose();
      reopenedPages.clear();
      reopenedPageTabs.clear();
      for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    },
  };
}
