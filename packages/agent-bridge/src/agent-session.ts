/**
 * AgentSession — the BRAIN driver.
 *
 * Starts `codex app-server` INSIDE a SandboxProvider, runs the handshake +
 * thread/start, and exposes a small turn API (submitTurn / steer / cancel) plus
 * a normalized AgentEvent stream. HITL server-requests (command/file approvals,
 * tool input) are held: each becomes a UxMessage on the stream, and the host
 * resolves it later with resolvePending().
 *
 * Trust boundary: the Plane-1 model key lives in THIS layer's env and is the
 * only secret injected into the sandbox. Plane-2 web/site credentials are never
 * passed in.
 */

import { EventEmitter } from 'node:events';
import type {
  AgentEvent,
  ApprovalPolicy,
  CodexRequest,
  SandboxMode,
  SandboxProvider,
  ThreadStartResult,
} from '@render/protocol';
import { CODEX } from '@render/protocol';
import { CodexClient, handshake } from './codex-client.js';
import { isHitlRequest, mapNotification, mapServerRequest } from './event-mapper.js';

export interface AgentSessionOptions {
  sandbox: SandboxProvider;
  /** codex binary name/path (resolved inside the sandbox) */
  codexBin?: string;
  /** extra args appended after `app-server` (e.g. ['-c','model="gpt-5-codex"']) */
  extraArgs?: string[];
  model?: string;
  modelProvider?: string;
  effort?: 'low' | 'medium' | 'high';
  approvalPolicy?: ApprovalPolicy;
  /** codex's OWN sandbox mode for the commands the agent runs (default workspace-write) */
  sandboxMode?: SandboxMode;
  /** Plane-1 env (model keys etc) injected into the sandbox — NEVER web creds */
  env?: Record<string, string>;
  /** if true, the caller manages sandbox.start()/dispose() */
  externalSandbox?: boolean;
  logRaw?: boolean;
}

interface PendingHitl {
  resolve: (result: unknown) => void;
  uxId: string;
}

export class AgentSession {
  readonly #opts: AgentSessionOptions;
  readonly #emitter = new EventEmitter();
  readonly #pendingHitl = new Map<number | string, PendingHitl>();
  #client: CodexClient | null = null;
  #threadId = '';
  #activeTurnId = '';
  #uxSeq = 0;
  #started = false;

  constructor(opts: AgentSessionOptions) {
    this.#opts = opts;
    this.#emitter.setMaxListeners(0);
  }

  get threadId(): string {
    return this.#threadId;
  }
  get activeTurnId(): string {
    return this.#activeTurnId;
  }

  /** Subscribe to the normalized AgentEvent stream. Returns an unsubscribe fn. */
  onAgentEvent(cb: (e: AgentEvent) => void): () => void {
    this.#emitter.on('event', cb);
    return () => this.#emitter.off('event', cb);
  }

  #emit(e: AgentEvent): void {
    this.#emitter.emit('event', e);
  }

  async start(): Promise<ThreadStartResult> {
    if (this.#started) throw new Error('AgentSession already started');
    this.#started = true;

    const { sandbox } = this.#opts;
    const provider = sandbox.id;
    const sandboxEnv = this.#opts.env;

    this.#emit({ kind: 'sandbox', status: 'spawning', provider });
    if (!this.#opts.externalSandbox) await sandbox.start({ env: sandboxEnv });

    const workdir = sandbox.workdir();
    const proc = sandbox.spawn(this.#opts.codexBin ?? 'codex', ['app-server', ...(this.#opts.extraArgs ?? [])], {
      cwd: workdir,
      env: sandboxEnv,
    });

    const client = new CodexClient({
      proc,
      logRaw: this.#opts.logRaw,
      onServerRequest: (req) => this.#handleServerRequest(req),
      onNotification: (n) => {
        const event = mapNotification(n);
        if (event) this.#emit(event);
      },
    });
    this.#client = client;
    client.on('exit', () => this.#emit({ kind: 'sandbox', status: 'closed', provider }));

    await handshake(client, { name: 'render', version: '0.0.1' });

    const started = await client.request<ThreadStartResult>(CODEX.threadStart, {
      cwd: workdir,
      approvalPolicy: this.#opts.approvalPolicy ?? 'on-request',
      sandbox: this.#opts.sandboxMode ?? 'workspace-write',
      ...(this.#opts.model ? { model: this.#opts.model } : {}),
      ...(this.#opts.modelProvider ? { modelProvider: this.#opts.modelProvider } : {}),
    });
    this.#threadId = started.thread.id;
    this.#emit({ kind: 'sandbox', status: 'ready', provider });
    return started;
  }

  /** Kick a new turn. Resolves with the turnId once codex accepts it. */
  async submitTurn(text: string): Promise<{ turnId: string }> {
    const client = this.#require();
    const res = await client.request<{ turn: { id: string } }>(CODEX.turnStart, {
      threadId: this.#threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(this.#opts.effort ? { effort: this.#opts.effort } : {}),
      ...(this.#opts.model ? { model: this.#opts.model } : {}),
    });
    this.#activeTurnId = res.turn.id;
    return { turnId: res.turn.id };
  }

  /** Inject guidance into the currently active turn. */
  async steer(text: string): Promise<void> {
    const client = this.#require();
    if (!this.#activeTurnId) throw new Error('steer: no active turn');
    await client.request(CODEX.turnSteer, {
      threadId: this.#threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      expectedTurnId: this.#activeTurnId,
    });
  }

  /** Interrupt the active turn. */
  async cancel(): Promise<void> {
    const client = this.#require();
    if (!this.#activeTurnId) return;
    await client.request('turn/interrupt', {
      threadId: this.#threadId,
      turnId: this.#activeTurnId,
    });
  }

  /**
   * Resolve a held HITL server-request. `reply` is the codex `result` payload —
   * e.g. `{ decision: 'approved' }` for an approval or `{ value: '…' }` for a
   * tool input. Keyed by the requestId carried on the UxMessage origin.
   */
  resolvePending(requestId: number | string, reply: unknown): void {
    const pending = this.#pendingHitl.get(requestId);
    if (!pending) throw new Error(`resolvePending: no pending request ${requestId}`);
    this.#pendingHitl.delete(requestId);
    pending.resolve(reply);
  }

  async dispose(): Promise<void> {
    this.#client?.close();
    this.#client = null;
    for (const p of this.#pendingHitl.values()) p.resolve({ decision: 'denied' });
    this.#pendingHitl.clear();
    if (!this.#opts.externalSandbox) await this.#opts.sandbox.dispose();
  }

  // ── HITL seam ────────────────────────────────────────────────────────────

  /**
   * Hold a server-request: surface it as a blocking UxMessage and return a
   * promise that resolves to the codex reply when the host calls resolvePending.
   * Non-HITL requests resolve immediately with an empty result.
   */
  #handleServerRequest(req: CodexRequest): Promise<unknown> {
    if (!isHitlRequest(req.method)) return Promise.resolve({});
    const uxId = `ux-${++this.#uxSeq}`;
    const message = mapServerRequest(req, uxId, Date.now());
    return new Promise<unknown>((resolve) => {
      this.#pendingHitl.set(req.id, { resolve, uxId });
      this.#emit({ kind: 'ux', message });
    });
  }

  #require(): CodexClient {
    if (!this.#client) throw new Error('AgentSession: start() not called');
    return this.#client;
  }
}
