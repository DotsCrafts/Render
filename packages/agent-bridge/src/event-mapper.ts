/**
 * Codex → Render normalization.
 *
 * Two maps:
 *   1. server NOTIFICATIONS  → AgentEvent  (the non-blocking stream the UI reads)
 *   2. server REQUESTS (HITL) → UxMessage  (blocking form/confirm/login surfaces)
 *
 * The mapping table is the one fixed in docs/render-architecture.html §6.
 */

import {
  CODEX_EVENT,
  CODEX_SERVER_REQUEST,
  type AgentEvent,
  type CodexItem,
  type CodexNotification,
  type CodexRequest,
  type UxMessage,
} from '@render/protocol';

type NotifParams = {
  turn?: { id?: string; status?: string; durationMs?: number };
  item?: CodexItem;
  itemId?: string;
  delta?: string;
  threadId?: string;
  message?: string;
  [k: string]: unknown;
};

/** Map a codex notification to a normalized AgentEvent (or null to drop it). */
export function mapNotification(n: CodexNotification): AgentEvent | null {
  const p = (n.params ?? {}) as NotifParams;
  switch (n.method) {
    case CODEX_EVENT.turnStarted:
      return { kind: 'turn_started', turnId: p.turn?.id ?? '' };
    case CODEX_EVENT.itemStarted:
      return p.item ? { kind: 'item', phase: 'started', item: p.item } : null;
    case CODEX_EVENT.itemCompleted:
      return p.item ? { kind: 'item', phase: 'completed', item: p.item } : null;
    case CODEX_EVENT.itemDelta:
      return { kind: 'delta', itemId: p.itemId, text: p.delta ?? '' };
    case CODEX_EVENT.reasoningDelta:
      return { kind: 'reasoning', itemId: p.itemId, text: p.delta ?? '' };
    case CODEX_EVENT.turnCompleted:
      // turnId lets consumers correlate completion with the turn it ends (a
      // single busy boolean misreports overlapping codex + /opencli turns).
      return {
        kind: 'turn_completed',
        status: p.turn?.status ?? 'unknown',
        ...(p.turn?.id ? { turnId: p.turn.id } : {}),
        durationMs: p.turn?.durationMs,
      };
    case CODEX_EVENT.error:
      return { kind: 'error', message: p.message ?? JSON.stringify(p) };
    default:
      return null;
  }
}

type ApprovalParams = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  command?: string;
  commandActions?: Array<{ command: string }>;
  diff?: string;
  files?: Array<{ path: string; kind?: string }>;
  prompt?: string;
  schema?: unknown;
};

/**
 * Map a HITL server-request to the UxMessage the panel renders. Every approval
 * is blocking — the codex request promise is held until the human resolves it.
 */
export function mapServerRequest(req: CodexRequest, uxId: string, ts: number): UxMessage {
  const p = (req.params ?? {}) as ApprovalParams;
  const origin = {
    threadId: p.threadId,
    turnId: p.turnId,
    itemId: p.itemId,
    requestId: req.id,
  };

  switch (req.method) {
    case CODEX_SERVER_REQUEST.toolUserInput:
    case CODEX_SERVER_REQUEST.mcpElicitation:
      return {
        id: uxId,
        kind: 'form',
        blocking: true,
        ts,
        origin,
        spec: {
          title: p.prompt ?? 'The agent needs some input',
          fields: [{ name: 'value', type: 'text', label: p.prompt ?? 'Value' }],
          submitLabel: 'Submit',
        },
      };

    case CODEX_SERVER_REQUEST.fileChangeApproval:
      return {
        id: uxId,
        kind: 'confirm',
        blocking: true,
        ts,
        origin,
        spec: {
          message: 'The agent wants to write files. Allow?',
          danger: true,
          detail: p.diff ?? (p.files ?? []).map((f) => `${f.kind ?? 'edit'} ${f.path}`).join('\n'),
        },
      };

    case CODEX_SERVER_REQUEST.commandApproval:
    case CODEX_SERVER_REQUEST.permissionsApproval:
    default: {
      const cmd =
        p.command ?? (p.commandActions ?? []).map((c) => c.command).join(' && ') ?? '(unknown)';
      return {
        id: uxId,
        kind: 'confirm',
        blocking: true,
        ts,
        origin,
        spec: {
          message: `The agent wants to run a command. Allow?`,
          danger: true,
          detail: cmd,
        },
      };
    }
  }
}

/** True for the server-request methods Render surfaces as blocking UX. */
export function isHitlRequest(method: string): boolean {
  return (Object.values(CODEX_SERVER_REQUEST) as string[]).includes(method);
}
