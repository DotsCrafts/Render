/**
 * IPC contract between the Electron main process (the hands) and the renderer
 * (browser chrome: floating input + agent panel). One-way streams use `emit`
 * channels (main→renderer); request/response uses `invoke` channels.
 *
 * The renderer is UNTRUSTED display surface. It never touches codex/opencli/CDP
 * directly — only these channels, brokered by preload's contextBridge.
 */

import type { UxMessage, UxResult } from './ux.js';
import type { CodexItem } from './codex.js';

// ── Agent runtime event stream (main → renderer) ─────────────────────────────

export type AgentEvent =
  | { kind: 'turn_started'; turnId: string }
  | { kind: 'item'; phase: 'started' | 'completed'; item: CodexItem }
  | { kind: 'delta'; itemId?: string; text: string }
  | { kind: 'reasoning'; itemId?: string; text: string }
  | { kind: 'ux'; message: UxMessage } // a render/form/confirm/login surfaced
  | { kind: 'turn_completed'; status: string; durationMs?: number }
  | { kind: 'sandbox'; status: 'spawning' | 'ready' | 'closed'; provider: string }
  | { kind: 'error'; message: string };

// ── Browser tab / human-hand state (main → renderer) ─────────────────────────

export interface TabState {
  id: string;
  title: string;
  url: string;
  favicon?: string;
  loading: boolean;
  /** true when the agent (CDP human-hand) is actively driving this tab */
  agentControlled: boolean;
}

export const IPC = {
  // renderer → main (invoke)
  submitPrompt: 'render:submitPrompt', // (text) → turnId
  steerTurn: 'render:steerTurn', // (text)
  cancelTurn: 'render:cancelTurn',
  resolveUx: 'render:resolveUx', // (id, UxResult)
  tabNavigate: 'render:tabNavigate', // ({tabId,url})
  tabCreate: 'render:tabCreate',
  tabClose: 'render:tabClose',
  tabActivate: 'render:tabActivate',
  setPanelWidth: 'render:setPanelWidth', // (width:number) — resize the agent panel
  getState: 'render:getState',

  // main → renderer (emit)
  agentEvent: 'render:agentEvent', // AgentEvent
  tabsChanged: 'render:tabsChanged', // TabState[]
} as const;

export interface RenderApi {
  submitPrompt(text: string): Promise<{ turnId: string }>;
  steerTurn(text: string): Promise<void>;
  cancelTurn(): Promise<void>;
  resolveUx(id: string, result: UxResult): Promise<void>;
  tabNavigate(tabId: string, url: string): Promise<void>;
  tabCreate(url?: string): Promise<{ tabId: string }>;
  tabClose(tabId: string): Promise<void>;
  tabActivate(tabId: string): Promise<void>;
  setPanelWidth(width: number): Promise<void>;
  getState(): Promise<{ tabs: TabState[]; events?: AgentEvent[] }>;
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  onTabsChanged(cb: (tabs: TabState[]) => void): () => void;
}
