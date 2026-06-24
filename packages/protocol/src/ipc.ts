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
  | { kind: 'artifact'; artifact: Artifact } // a Tier-2 ephemeral app delivered
  | { kind: 'turn_completed'; status: string; durationMs?: number }
  | { kind: 'sandbox'; status: 'spawning' | 'ready' | 'closed'; provider: string }
  | { kind: 'error'; message: string };

/**
 * A Tier-2 artifact — an ephemeral, isolated agent-generated mini-app the human
 * drives DIRECTLY (no longer per-turn through the agent). Opened in its own
 * WebContentsView tab on a fresh in-memory partition (`artifact:<id>`), NEVER the
 * shared `persist:render` session that holds the user's logins. "阅后即焚":
 * no persistence/versioning in M1 — gone when the tab closes / conversation ends.
 *
 * M1: `format:'html'` only, `content` inline. The optional `opencli` allowlist
 * declares which `<site> <command>` reads the artifact may run through the
 * narrow, user-consented capability bridge (see window.renderArtifact.opencli).
 */
export interface Artifact {
  id: string;
  title: string;
  format: 'html';
  /** inline artifact source (M1: the full HTML document) */
  content: string;
  /** allowlist of `"<site> <command>"` opencli reads this artifact may request */
  opencli?: string[];
}

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
  setOverlay: 'render:setOverlay', // (hidden:boolean) — hide page views for a renderer modal
  getState: 'render:getState',

  // codex provider/auth (Phase A) — all return CodexProviderStatus
  codexStatus: 'render:codexStatus',
  codexSetProvider: 'render:codexSetProvider', // (CodexProviderConfig)
  codexLoginApiKey: 'render:codexLoginApiKey', // (apiKey)
  codexLoginOAuth: 'render:codexLoginOAuth', // opens auth URL in a Render tab
  codexLogout: 'render:codexLogout',

  // main → renderer (emit)
  agentEvent: 'render:agentEvent', // AgentEvent
  tabsChanged: 'render:tabsChanged', // TabState[]

  // artifact → main (invoke, via the SEPARATE artifact-preload only)
  // the narrow, consented opencli capability a Tier-2 artifact page may call.
  artifactOpencli: 'render:artifactOpencli', // (ArtifactOpencliRequest) → ArtifactOpencliResult
} as const;

/**
 * A read request a Tier-2 artifact makes against opencli through the consented
 * capability bridge. `artifactId` scopes the call to its declared allowlist and
 * its cached consent grant; `site`/`command`/`args` form the opencli invocation.
 */
export interface ArtifactOpencliRequest {
  artifactId: string;
  site: string;
  command: string;
  args?: Record<string, string | number | boolean>;
}

export interface ArtifactOpencliResult {
  ok: boolean;
  /** parsed JSON opencli returned on success */
  data?: unknown;
  /** why the call was rejected (not allowlisted / consent denied / not a read / failed) */
  error?: string;
}

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
  /** hide/show native page views so a renderer modal isn't occluded by them */
  setOverlay(hidden: boolean): Promise<void>;
  getState(): Promise<{ tabs: TabState[]; events?: AgentEvent[] }>;
  codexStatus(): Promise<CodexProviderStatus>;
  codexSetProvider(p: CodexProviderConfig): Promise<CodexProviderStatus>;
  codexLoginApiKey(apiKey: string): Promise<CodexProviderStatus>;
  codexLoginOAuth(): Promise<CodexProviderStatus>;
  codexLogout(): Promise<CodexProviderStatus>;
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  onTabsChanged(cb: (tabs: TabState[]) => void): () => void;
}

/**
 * The narrow capability surface exposed to a Tier-2 artifact page ONLY (via the
 * dedicated artifact-preload, never the main preload). An artifact page calls
 * `window.renderArtifact.opencli(site, command, args)` to aggregate content from
 * a backend through the consented, allowlisted, read-only opencli bridge.
 */
export interface RenderArtifactApi {
  /** this artifact's id — baked in by the preload so the page can't spoof it */
  readonly artifactId: string;
  opencli(
    site: string,
    command: string,
    args?: Record<string, string | number | boolean>,
  ): Promise<ArtifactOpencliResult>;
}
