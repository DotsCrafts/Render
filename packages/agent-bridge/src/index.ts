/**
 * @render/agent-bridge — the BRAIN driver.
 *
 * Runs `codex app-server` inside a SandboxProvider and exposes a typed turn API
 * plus a normalized AgentEvent stream. HITL approvals are surfaced as UxMessages
 * and resolved out-of-band.
 */

export { CodexClient, handshake } from './codex-client.js';
export type { CodexClientOptions } from './codex-client.js';
export { AgentSession } from './agent-session.js';
export type { AgentSessionOptions } from './agent-session.js';
export { mapNotification, mapServerRequest, isHitlRequest } from './event-mapper.js';

// Convenience re-exports of the contracts callers need.
export type { AgentEvent, UxMessage } from '@render/protocol';
