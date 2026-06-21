/**
 * Codex app-server protocol — the BRAIN wire format.
 *
 * Transport: JSON-RPC-lite over stdio (newline-delimited JSON, JSONL).
 * Shape mirrors JSON-RPC 2.0 (request/response/notification) but WITHOUT the
 * `"jsonrpc":"2.0"` envelope field. Validated against codex-cli 0.136.0 in
 * codex-opencli-poc/stage1-appserver.
 *
 * Only the subset Render drives is modeled here; codex emits ~545 generated
 * types — we keep this hand-curated and forward-compatible (unknown items pass
 * through as `CodexItem` with a string `type`).
 */

// ── Framing ────────────────────────────────────────────────────────────────

export interface CodexRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface CodexResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message: string };
}

export interface CodexNotification {
  method: string;
  params?: unknown;
}

export type CodexFrame = CodexRequest | CodexResponse | CodexNotification;

export const isResponse = (f: CodexFrame): f is CodexResponse =>
  'id' in f && !('method' in f);
export const isServerRequest = (f: CodexFrame): f is CodexRequest =>
  'id' in f && 'method' in f;
export const isNotification = (f: CodexFrame): f is CodexNotification =>
  !('id' in f) && 'method' in f;

// ── Client → Server requests (Render drives these) ──────────────────────────

export interface InitializeParams {
  clientInfo: { name: string; version: string };
  capabilities?: Record<string, unknown>;
}
export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformOs: string;
}

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'on-failure' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface ThreadStartParams {
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  model?: string;
  modelProvider?: string;
}
export interface ThreadStartResult {
  thread: { id: string };
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
}

export interface TurnStartParams {
  threadId: string;
  input: string | TurnInputItem[];
  effort?: 'low' | 'medium' | 'high';
}
export type TurnInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string };

export interface TurnSteerParams {
  threadId: string;
  input: string;
}

// Method name constants — single source of truth for callers.
export const CODEX = {
  initialize: 'initialize',
  initialized: 'initialized',
  getAuthStatus: 'getAuthStatus',
  modelList: 'model/list',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
} as const;

// ── Server → Client notifications (streamed events) ─────────────────────────

export type CodexItemType =
  | 'userMessage'
  | 'agentMessage'
  | 'reasoning'
  | 'plan'
  | 'commandExecution'
  | 'fileChange'
  | 'mcpToolCall'
  | (string & {}); // forward-compat: unknown item types still typed as string

export interface CodexItem {
  id?: string;
  type: CodexItemType;
  text?: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  [k: string]: unknown;
}

export interface ItemEvent {
  item: CodexItem;
  threadId?: string;
  turnId?: string;
}
export interface DeltaEvent {
  delta: string;
  itemId?: string;
}
export interface TurnCompletedEvent {
  turn: { status: 'completed' | 'failed' | 'cancelled'; durationMs?: number };
}

export const CODEX_EVENT = {
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  itemDelta: 'item/agentMessage/delta',
  reasoningDelta: 'item/reasoning/delta',
  error: 'error',
} as const;

// ── Server → Client requests (HITL — Render MUST reply) ──────────────────────
//
// These are the seams the json-render UX layer surfaces to the human.
// All expect a reply: { id, result: { decision } }.

export const CODEX_SERVER_REQUEST = {
  fileChangeApproval: 'item/fileChange/requestApproval',
  commandApproval: 'item/commandExecution/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  toolUserInput: 'item/tool/requestUserInput',
  mcpElicitation: 'mcpServer/elicitation/request',
} as const;

export type ApprovalDecision =
  | 'approved'
  | 'accept'
  | 'acceptForSession'
  | 'denied'
  | 'decline'
  | 'cancel';

export interface ApprovalRequestParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs?: number;
  command?: string;
  commandActions?: Array<{ command: string }>;
  // fileChange variant carries a unified diff / file list:
  diff?: string;
  files?: Array<{ path: string; kind?: string }>;
}

export interface ApprovalReply {
  decision: ApprovalDecision;
}

/** tool/requestUserInput — a structured form the agent needs filled. */
export interface ToolUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  prompt?: string;
  schema?: unknown; // JSON-schema-ish; mapped to a ux form by the UX layer
}
