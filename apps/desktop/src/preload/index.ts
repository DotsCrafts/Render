/**
 * Preload — the ONLY bridge between the untrusted renderer and the trusted main
 * process. Exposes the protocol `RenderApi` over contextBridge; the renderer can
 * never reach codex / opencli / CDP except through these channels.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AgentEvent,
  type RenderApi,
  type TabState,
  type UxResult,
  type CodexProviderConfig,
} from '@render/protocol';
import { CHROME_IPC, type RenderChromeApi } from '../shared/chrome-channels.js';

const api: RenderApi = {
  submitPrompt: (text) => ipcRenderer.invoke(IPC.submitPrompt, text),
  steerTurn: (text) => ipcRenderer.invoke(IPC.steerTurn, text),
  cancelTurn: () => ipcRenderer.invoke(IPC.cancelTurn),
  resolveUx: (id: string, result: UxResult) => ipcRenderer.invoke(IPC.resolveUx, id, result),
  tabNavigate: (tabId, url) => ipcRenderer.invoke(IPC.tabNavigate, { tabId, url }),
  tabCreate: (url) => ipcRenderer.invoke(IPC.tabCreate, url),
  tabClose: (tabId) => ipcRenderer.invoke(IPC.tabClose, tabId),
  tabActivate: (tabId) => ipcRenderer.invoke(IPC.tabActivate, tabId),
  setPanelWidth: (width) => ipcRenderer.invoke(IPC.setPanelWidth, width),
  setOverlay: (hidden) => ipcRenderer.invoke(IPC.setOverlay, hidden),
  getState: () => ipcRenderer.invoke(IPC.getState),

  codexStatus: () => ipcRenderer.invoke(IPC.codexStatus),
  codexSetProvider: (p: CodexProviderConfig) => ipcRenderer.invoke(IPC.codexSetProvider, p),
  codexLoginApiKey: (apiKey: string) => ipcRenderer.invoke(IPC.codexLoginApiKey, apiKey),
  codexLoginOAuth: () => ipcRenderer.invoke(IPC.codexLoginOAuth),
  codexLogout: () => ipcRenderer.invoke(IPC.codexLogout),

  onAgentEvent: (cb: (e: AgentEvent) => void) => {
    const listener = (_e: unknown, event: AgentEvent): void => cb(event);
    ipcRenderer.on(IPC.agentEvent, listener);
    return () => ipcRenderer.removeListener(IPC.agentEvent, listener);
  },
  onTabsChanged: (cb: (tabs: TabState[]) => void) => {
    const listener = (_e: unknown, tabs: TabState[]): void => cb(tabs);
    ipcRenderer.on(IPC.tabsChanged, listener);
    return () => ipcRenderer.removeListener(IPC.tabsChanged, listener);
  },
};

const chrome: RenderChromeApi = {
  back: (tabId) => ipcRenderer.invoke(CHROME_IPC.back, tabId),
  forward: (tabId) => ipcRenderer.invoke(CHROME_IPC.forward, tabId),
  reload: (tabId) => ipcRenderer.invoke(CHROME_IPC.reload, tabId),
};

contextBridge.exposeInMainWorld('render', api);
contextBridge.exposeInMainWorld('renderChrome', chrome);
