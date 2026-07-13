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
import type { ConnectorInfo } from './connectors.js';

// ── Agent runtime event stream (main → renderer) ─────────────────────────────

export type AgentEvent =
  | { kind: 'turn_started'; turnId: string }
  | { kind: 'item'; phase: 'started' | 'completed'; item: CodexItem }
  | { kind: 'delta'; itemId?: string; text: string }
  | { kind: 'reasoning'; itemId?: string; text: string }
  | { kind: 'ux'; message: UxMessage } // a render/form/confirm/login surfaced
  | { kind: 'turn_completed'; status: string; turnId?: string; durationMs?: number }
  | { kind: 'sandbox'; status: 'spawning' | 'ready' | 'closed'; provider: string }
  | { kind: 'error'; message: string };

// ── Browser tab / human-hand state (main → renderer) ─────────────────────────

/**
 * A tab group — Chrome-style. opencli's "owned tab group" (one agent session's
 * leases) is surfaced as a group so the user can see, at a glance, which tabs
 * the agent opened (e.g. a site login tab + the pages it's scraping).
 */
export interface TabGroupInfo {
  id: string;
  label: string;
  /** CSS color for the group accent (border / chip). */
  color: string;
}

export interface TabState {
  id: string;
  title: string;
  url: string;
  favicon?: string;
  loading: boolean;
  /** true when the agent (CDP human-hand) is actively driving this tab */
  agentControlled: boolean;
  /** present when this tab belongs to a tab group (e.g. the agent's session). */
  group?: TabGroupInfo;
}

// ── Saved render-pages (Delta 3 persistence) ─────────────────────────────────

/** A persisted page version: the json-render spec + its server-owned grants. */
export interface SavedPageRecord {
  id: string;
  title: string;
  /** the json-render page spec, as a JSON string (re-served live on reopen) */
  specJson: string;
  /** the `<site> <command>,…` allowlist the page may run via /ux/data */
  allow: string;
  /** per-command write grants (`--allow-write "site cmd,…"`) — each run human-confirmed */
  allowWrite?: string;
  convId?: string;
  /** monotonic version (newest is live); bumped by the Ask-agent loop */
  version: number;
  savedAt: number;
  /** true once the human explicitly saved it (shows in the gallery) */
  saved: boolean;
}

/** Gallery-facing summary (the spec is omitted — fetched on reopen). */
export type SavedPageMeta = Omit<SavedPageRecord, 'specJson'>;

// ── Codex provider / auth (Phase A) ──────────────────────────────────────────

export type CodexWireApi = 'chat' | 'responses';
export type CodexAuthMode = 'oauth' | 'apikey';

export interface CodexProviderConfig {
  /** model_providers.<name> key + model_provider value */
  name: string;
  /** provider base URL; empty = codex's built-in OpenAI default */
  baseUrl?: string;
  wireApi: CodexWireApi;
  authMode: CodexAuthMode;
}

export interface CodexProviderStatus {
  provider: CodexProviderConfig;
  authed: boolean;
  authKind: CodexAuthMode | null;
  /** masked display hint, e.g. "sk-5e49…7ad9f" or "ChatGPT" */
  hint: string;
}

export const IPC = {
  // renderer → main (invoke)
  submitPrompt: 'render:submitPrompt', // (text) → turnId
  steerTurn: 'render:steerTurn', // (text)
  cancelTurn: 'render:cancelTurn',
  resolveUx: 'render:resolveUx', // (id, UxResult)
  newConversation: 'render:newConversation', // () → TabGroupInfo — fresh thread + tab group
  tabNavigate: 'render:tabNavigate', // ({tabId,url})
  tabCreate: 'render:tabCreate',
  tabClose: 'render:tabClose',
  tabActivate: 'render:tabActivate',
  setPanelWidth: 'render:setPanelWidth', // (width:number) — resize the agent panel
  setPanelOpen: 'render:setPanelOpen', // (open:boolean) — collapse/expand the agent panel
  setInputOpen: 'render:setInputOpen', // (open:boolean) — summon/dismiss the floating input layer
  setOverlay: 'render:setOverlay', // (hidden:boolean) — hide page views for a renderer modal
  getState: 'render:getState',

  // saved render-pages (Delta 3) — persist a spec, list the gallery, reopen live
  savePage: 'render:savePage', // (id) → SavedPageMeta | null
  listPages: 'render:listPages', // () → SavedPageMeta[]
  openPage: 'render:openPage', // (id) → boolean (re-served + opened in a tab)
  askPage: 'render:askPage', // (id, instruction) — pull a page back into the agent

  // codex provider/auth (Phase A) — all return CodexProviderStatus
  codexStatus: 'render:codexStatus',
  codexSetProvider: 'render:codexSetProvider', // (CodexProviderConfig)
  codexLoginApiKey: 'render:codexLoginApiKey', // (apiKey)
  codexLoginOAuth: 'render:codexLoginOAuth', // opens auth URL in a Render tab
  codexLogout: 'render:codexLogout',

  // connectors (site login state, Manus-connector mental model) — all return the
  // full ConnectorInfo[] snapshot; long-running transitions stream over the emit.
  connectorsList: 'render:connectorsList',
  connectorsRefresh: 'render:connectorsRefresh', // (site?) — probe whoami
  connectorsConnect: 'render:connectorsConnect', // (site) — open login + watch
  connectorsDisconnect: 'render:connectorsDisconnect', // (site) — logout + reprobe

  // main → renderer (emit)
  agentEvent: 'render:agentEvent', // AgentEvent
  tabsChanged: 'render:tabsChanged', // TabState[]
  connectorsChanged: 'render:connectorsChanged', // ConnectorInfo[]
  summonInput: 'render:summonInput', // app-menu ⌘K — summon + focus the input layer
} as const;

export interface RenderApi {
  submitPrompt(text: string): Promise<{ turnId: string }>;
  steerTurn(text: string): Promise<void>;
  cancelTurn(): Promise<void>;
  resolveUx(id: string, result: UxResult): Promise<void>;
  /** Start a fresh agent conversation (new codex thread + new tab group). */
  newConversation(): Promise<TabGroupInfo>;
  tabNavigate(tabId: string, url: string): Promise<void>;
  tabCreate(url?: string): Promise<{ tabId: string }>;
  tabClose(tabId: string): Promise<void>;
  tabActivate(tabId: string): Promise<void>;
  setPanelWidth(width: number): Promise<void>;
  /** collapse/expand the agent panel — re-insets native page views to fill the gap */
  setPanelOpen(open: boolean): Promise<void>;
  /** summon/dismiss the floating input layer — pages reclaim the band when hidden */
  setInputOpen(open: boolean): Promise<void>;
  /** hide/show native page views so a renderer modal isn't occluded by them */
  setOverlay(hidden: boolean): Promise<void>;
  getState(): Promise<{
    tabs: TabState[];
    events?: AgentEvent[];
    resolvedUxIds?: string[];
    /** main's input-layer state — restored on renderer reload (default open) */
    inputOpen?: boolean;
  }>;
  /** Flip a delivered page to saved:true so it joins the Saved-Pages gallery. */
  savePage(id: string): Promise<SavedPageMeta | null>;
  /** List the saved pages (newest-first) for the gallery launcher. */
  listPages(): Promise<SavedPageMeta[]>;
  /** Re-serve a saved page's spec and open it in a tab. */
  openPage(id: string): Promise<boolean>;
  /** Pull a page back into the conversation, seeded with its spec, to iterate. */
  askPage(id: string, instruction: string): Promise<void>;
  codexStatus(): Promise<CodexProviderStatus>;
  codexSetProvider(p: CodexProviderConfig): Promise<CodexProviderStatus>;
  codexLoginApiKey(apiKey: string): Promise<CodexProviderStatus>;
  codexLoginOAuth(): Promise<CodexProviderStatus>;
  codexLogout(): Promise<CodexProviderStatus>;
  /** The current connector snapshot (cached statuses; no probes spawned). */
  connectorsList(): Promise<ConnectorInfo[]>;
  /** Probe whoami for one site, or all stale login sites when omitted. */
  connectorsRefresh(site?: string): Promise<ConnectorInfo[]>;
  /** Open the site's login inside Render and watch whoami until it flips. */
  connectorsConnect(site: string): Promise<ConnectorInfo[]>;
  /** Best-effort `opencli <site> logout`, then re-probe. */
  connectorsDisconnect(site: string): Promise<ConnectorInfo[]>;
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  onTabsChanged(cb: (tabs: TabState[]) => void): () => void;
  onConnectorsChanged(cb: (connectors: ConnectorInfo[]) => void): () => void;
  /** app-menu ⌘K (works while a native page view has focus) → summon + focus the input */
  onSummonInput(cb: () => void): () => void;
}
