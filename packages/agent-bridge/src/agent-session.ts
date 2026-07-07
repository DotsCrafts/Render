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
  CodexNotification,
  CodexRequest,
  SandboxMode,
  SandboxProvider,
  ThreadStartResult,
  TurnInputItem,
  TurnSteerParams,
} from '@render/protocol';
import type { ApprovalDecision } from '@render/protocol';
import { CODEX, CODEX_EVENT } from '@render/protocol';
import { CodexClient, handshake } from './codex-client.js';
import { type CodexHome, prepareCodexHome } from './codex-home.js';
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
  /**
   * Run codex against a hook-free CODEX_HOME so command/file approvals flow over
   * the app-server protocol (→ the HITL seam) instead of being swallowed by a
   * local ~/.codex `PermissionRequest` hook (B2). Best-effort: if the source
   * home can't be read, falls back to codex's default home. Injects CODEX_HOME
   * into the sandbox env and cleans up the temp home on dispose().
   */
  hookFreeCodexHome?: boolean;
  /** source home to derive the hook-free home from (defaults to ~/.codex) */
  codexHomeSource?: string;
  logRaw?: boolean;
}

/**
 * Normalize a human allow/deny choice to a codex 0.136.0 approval decision.
 * codex expects `accept` / `cancel` (NOT `approved`/`denied`) — replying with
 * the wrong token makes codex fail to deserialize the response and the command
 * fails to run (B1).
 */
export function approvalDecision(allow: boolean): ApprovalDecision {
  return allow ? 'accept' : 'cancel';
}

interface PendingHitl {
  resolve: (result: unknown) => void;
  uxId: string;
}

/**
 * Boot deadline for handshake + thread/start. A codex that spawns but never
 * answers (bad binary, wedged provider config) would otherwise suspend
 * `start()` forever — CodexClient.request has no timeout of its own.
 */
const BOOT_TIMEOUT_MS = 20_000;

/** codex 0.136 wire shape for a text input item (`text_elements` is required
 *  by the deserializer even when empty; the protocol type omits it). */
const textInputItem = (text: string): TurnInputItem =>
  ({ type: 'text', text, text_elements: [] }) as TurnInputItem;

export class AgentSession {
  readonly #opts: AgentSessionOptions;
  readonly #emitter = new EventEmitter();
  readonly #pendingHitl = new Map<number | string, PendingHitl>();
  #client: CodexClient | null = null;
  #codexHome: CodexHome | null = null;
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
    let sandboxEnv = this.#opts.env;

    // B2: derive a hook-free CODEX_HOME so approvals flow over the protocol.
    if (this.#opts.hookFreeCodexHome) {
      this.#codexHome = await prepareCodexHome(this.#opts.codexHomeSource);
      if (this.#codexHome) sandboxEnv = { ...sandboxEnv, CODEX_HOME: this.#codexHome.path };
    }

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
        this.#trackTurnLifecycle(n);
        const event = mapNotification(n);
        if (event) this.#emit(event);
      },
    });
    this.#client = client;
    client.on('exit', () => this.#emit({ kind: 'sandbox', status: 'closed', provider }));

    // Boot must fail loudly, not hang: a missing/broken codex binary rejects
    // via the SandboxProcess error path, but a spawned-yet-mute codex would
    // suspend these awaits forever without the deadline. On failure, kill the
    // child so a half-booted app-server doesn't linger.
    try {
      await withDeadline(
        handshake(client, { name: 'render', version: '0.0.1' }),
        BOOT_TIMEOUT_MS,
        'codex handshake',
      );

      const started = await withDeadline(
        client.request<ThreadStartResult>(CODEX.threadStart, {
          cwd: workdir,
          approvalPolicy: this.#opts.approvalPolicy ?? 'on-request',
          sandbox: this.#opts.sandboxMode ?? 'workspace-write',
          ...(this.#opts.model ? { model: this.#opts.model } : {}),
          ...(this.#opts.modelProvider ? { modelProvider: this.#opts.modelProvider } : {}),
        }),
        BOOT_TIMEOUT_MS,
        'codex thread/start',
      );
      this.#threadId = started.thread.id;
      this.#emit({ kind: 'sandbox', status: 'ready', provider });
      return started;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  /**
   * Keep #activeTurnId honest from the raw notification stream: codex sets it
   * on turn/started (covers resumed threads) and it must CLEAR when that turn
   * completes — otherwise `activeTurnId` stays truthy forever after the first
   * turn and hosts steer answers into a dead turn (silently losing them).
   */
  #trackTurnLifecycle(n: CodexNotification): void {
    const p = (n.params ?? {}) as { turn?: { id?: string } };
    if (n.method === CODEX_EVENT.turnStarted && p.turn?.id) {
      this.#activeTurnId = p.turn.id;
      return;
    }
    if (n.method === CODEX_EVENT.turnCompleted && p.turn?.id === this.#activeTurnId) {
      this.#activeTurnId = '';
    }
  }

  /** Kick a new turn. Resolves with the turnId once codex accepts it. */
  async submitTurn(text: string): Promise<{ turnId: string }> {
    const client = this.#require();
    const res = await client.request<{ turn: { id: string } }>(CODEX.turnStart, {
      threadId: this.#threadId,
      input: [textInputItem(text)],
      ...(this.#opts.effort ? { effort: this.#opts.effort } : {}),
      ...(this.#opts.model ? { model: this.#opts.model } : {}),
    });
    this.#activeTurnId = res.turn.id;
    return { turnId: res.turn.id };
  }

  /**
   * Inject guidance into the currently active turn. Throws when no turn is
   * live (also when codex rejects the expectedTurnId because the turn ended
   * between our check and the RPC) — callers fall back to a fresh submit.
   */
  async steer(text: string): Promise<void> {
    const client = this.#require();
    if (!this.#activeTurnId) throw new Error('steer: no active turn');
    const params: TurnSteerParams = {
      threadId: this.#threadId,
      input: [textInputItem(text)],
      expectedTurnId: this.#activeTurnId,
    };
    await client.request(CODEX.turnSteer, params);
  }

  /** Interrupt the active turn. */
  async cancel(): Promise<void> {
    const client = this.#require();
    if (!this.#activeTurnId) return;
    await client.request('turn/interrupt', {
      threadId: this.#threadId,
      turnId: this.#activeTurnId,
    });
    // The interrupted turn is dead — clear immediately rather than waiting for
    // the turn/completed notification, so a steer can't target it in between.
    this.#activeTurnId = '';
  }

  /**
   * Resolve a held HITL server-request. `reply` is the codex `result` payload —
   * e.g. `{ decision: 'accept' }` (or `{ decision: 'cancel' }` to deny) for an
   * approval, or `{ value: '…' }` for a tool input. codex 0.136.0 wants
   * `accept`/`cancel`, NOT `approved`/`denied` — use `approvalDecision()` to
   * normalize an allow/deny choice. Keyed by the requestId on the UxMessage origin.
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
    // Deny any still-pending approvals on the way out (B1: codex wants `cancel`).
    for (const p of this.#pendingHitl.values()) p.resolve({ decision: 'cancel' });
    this.#pendingHitl.clear();
    if (!this.#opts.externalSandbox) await this.#opts.sandbox.dispose();
    await this.#codexHome?.cleanup();
    this.#codexHome = null;
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

/** Race a boot step against a deadline, always clearing the timer. */
async function withDeadline<T>(step: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} timed out after ${Math.round(timeoutMs / 1000)}s — ` +
              'is the codex binary installed and responsive?',
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([step, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
