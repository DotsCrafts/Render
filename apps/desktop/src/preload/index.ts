/**
 * Preload — the ONLY bridge between the untrusted renderer and the trusted main
 * process. Exposes the protocol `RenderApi` over contextBridge; the renderer can
 * never reach codex / opencli / CDP except through these channels.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AgentEvent,
  type ConnectorInfo,
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
  newConversation: () => ipcRenderer.invoke(IPC.newConversation),
  tabNavigate: (tabId, url) => ipcRenderer.invoke(IPC.tabNavigate, { tabId, url }),
  tabCreate: (url) => ipcRenderer.invoke(IPC.tabCreate, url),
  tabClose: (tabId) => ipcRenderer.invoke(IPC.tabClose, tabId),
  tabActivate: (tabId) => ipcRenderer.invoke(IPC.tabActivate, tabId),
  setPanelWidth: (width) => ipcRenderer.invoke(IPC.setPanelWidth, width),
  setPanelOpen: (open) => ipcRenderer.invoke(IPC.setPanelOpen, open),
  setInputOpen: (open) => ipcRenderer.invoke(IPC.setInputOpen, open),
  setOverlay: (hidden) => ipcRenderer.invoke(IPC.setOverlay, hidden),
  getState: () => ipcRenderer.invoke(IPC.getState),

  savePage: (id: string) => ipcRenderer.invoke(IPC.savePage, id),
  listPages: () => ipcRenderer.invoke(IPC.listPages),
  openPage: (id: string) => ipcRenderer.invoke(IPC.openPage, id),
  askPage: (id: string, instruction: string) => ipcRenderer.invoke(IPC.askPage, id, instruction),

  codexStatus: () => ipcRenderer.invoke(IPC.codexStatus),
  codexSetProvider: (p: CodexProviderConfig) => ipcRenderer.invoke(IPC.codexSetProvider, p),
  codexLoginApiKey: (apiKey: string) => ipcRenderer.invoke(IPC.codexLoginApiKey, apiKey),
  codexLoginOAuth: () => ipcRenderer.invoke(IPC.codexLoginOAuth),
  codexLogout: () => ipcRenderer.invoke(IPC.codexLogout),

  connectorsList: () => ipcRenderer.invoke(IPC.connectorsList),
  connectorsRefresh: (site?: string) => ipcRenderer.invoke(IPC.connectorsRefresh, site),
  connectorsConnect: (site: string) => ipcRenderer.invoke(IPC.connectorsConnect, site),
  connectorsDisconnect: (site: string) => ipcRenderer.invoke(IPC.connectorsDisconnect, site),

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
  onConnectorsChanged: (cb: (connectors: ConnectorInfo[]) => void) => {
    const listener = (_e: unknown, connectors: ConnectorInfo[]): void => cb(connectors);
    ipcRenderer.on(IPC.connectorsChanged, listener);
    return () => ipcRenderer.removeListener(IPC.connectorsChanged, listener);
  },
  onSummonInput: (cb: () => void) => {
    const listener = (): void => cb();
    ipcRenderer.on(IPC.summonInput, listener);
    return () => ipcRenderer.removeListener(IPC.summonInput, listener);
  },
};

const chrome: RenderChromeApi = {
  back: (tabId) => ipcRenderer.invoke(CHROME_IPC.back, tabId),
  forward: (tabId) => ipcRenderer.invoke(CHROME_IPC.forward, tabId),
  reload: (tabId) => ipcRenderer.invoke(CHROME_IPC.reload, tabId),
};

contextBridge.exposeInMainWorld('render', api);
contextBridge.exposeInMainWorld('renderChrome', chrome);
