/**
 * IPC broker — wires the protocol RenderApi channels to the trusted hands.
 *
 * The renderer is untrusted display: it only ever speaks these channels. Each
 * `invoke` handler maps directly onto a protocol method; `emit` channels push
 * the AgentEvent stream and TabState snapshots back. Shapes are taken verbatim
 * from @render/protocol so the real bridge is drop-in.
 */

import { ipcMain, type WebContents } from 'electron';
import { IPC, type AgentEvent, type TabState, type UxResult } from '@render/protocol';
import type { HumanHandHandle } from '@render/cdp-human-hand';
import { CHROME_IPC } from '../shared/chrome-channels.js';
import type { TabManager } from './tabs.js';
import type { AgentRuntime } from './agent-runtime.js';

export interface IpcDeps {
  /** the chrome renderer that receives emit() events */
  chrome: WebContents;
  tabs: TabManager;
  agent: AgentRuntime;
  humanHand: HumanHandHandle;
}

export interface IpcBroker {
  emitAgent: (event: AgentEvent) => void;
  emitTabs: (snapshot: TabState[]) => void;
  dispose: () => void;
}

export function registerIpc(deps: IpcDeps): IpcBroker {
  const { chrome, tabs, agent, humanHand } = deps;

  const emitAgent = (event: AgentEvent): void => {
    if (!chrome.isDestroyed()) chrome.send(IPC.agentEvent, event);
  };
  const emitTabs = (snapshot: TabState[]): void => {
    if (!chrome.isDestroyed()) chrome.send(IPC.tabsChanged, snapshot);
  };

  const handlers: Record<string, (...args: never[]) => unknown> = {
    [IPC.submitPrompt]: (_e, text: string) => agent.submit(text),
    [IPC.steerTurn]: (_e, text: string) => agent.steer(text),
    [IPC.cancelTurn]: () => agent.cancel(),
    [IPC.resolveUx]: (_e, id: string, result: UxResult) => agent.resolveUx(id, result),
    // (agent runtime methods are async; ipcMain.handle awaits the returned promise)

    [IPC.tabNavigate]: (_e, payload: { tabId: string; url: string }) =>
      tabs.navigate(payload.tabId, payload.url),
    [IPC.tabCreate]: (_e, url?: string) => ({ tabId: tabs.create(url) }),
    [IPC.tabClose]: (_e, tabId: string) => tabs.close(tabId),
    [IPC.tabActivate]: (_e, tabId: string) => tabs.activate(tabId),
    [IPC.getState]: () => ({ tabs: tabs.snapshot() }),

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
      for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    },
  };
}
