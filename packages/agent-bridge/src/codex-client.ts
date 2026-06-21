/**
 * CodexClient — typed codex app-server driver over a SandboxProcess.
 *
 * Lifted from codex-opencli-poc/stage1-appserver/client.mjs and adapted so the
 * BRAIN runs INSIDE a SandboxProvider: instead of spawning the child itself, the
 * client speaks JSONL over a `SandboxProcess` (the spawned `codex app-server`).
 *
 * Transport: "JSON-RPC lite" — request/response/notification framed as one JSON
 * object per line, WITHOUT the `"jsonrpc":"2.0"` envelope. Validated against
 * codex-cli 0.136.0.
 *
 * Style: framework-free, immutable — protocol frames are frozen on receipt and
 * never mutated after construction.
 */

import { EventEmitter } from 'node:events';
import type { SandboxProcess } from '@render/protocol';
import {
  CODEX,
  type CodexFrame,
  type CodexNotification,
  type CodexRequest,
  type InitializeParams,
  type InitializeResult,
} from '@render/protocol';

export interface CodexClientOptions {
  proc: SandboxProcess;
  /** resolve a server-initiated request (approval / user-input) → the `result` payload */
  onServerRequest?: (req: CodexRequest) => Promise<unknown> | unknown;
  onNotification?: (n: CodexNotification) => void;
  /** echo every framed line to stderr for debugging */
  logRaw?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class CodexClient {
  readonly #proc: SandboxProcess;
  readonly #bus = new EventEmitter();
  readonly #pending = new Map<number | string, Pending>();
  readonly #notifications: CodexNotification[] = [];
  readonly #opts: CodexClientOptions;
  #buffer = '';
  #nextId = 1;
  #closed = false;

  constructor(opts: CodexClientOptions) {
    this.#proc = opts.proc;
    this.#opts = opts;
    this.#bus.setMaxListeners(0);

    this.#proc.onStdout((chunk) => this.#ingest(chunk));
    this.#proc.onStderr((chunk) => {
      if (opts.logRaw) process.stderr.write(`[server.stderr] ${chunk}`);
    });
    this.#proc.onExit((code) => {
      this.#closed = true;
      const err = new Error(`app-server exited (code=${code})`);
      for (const { reject } of this.#pending.values()) reject(err);
      this.#pending.clear();
      this.#bus.emit('exit', { code });
    });
  }

  // ── framing ────────────────────────────────────────────────────────────────

  #ingest(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      if (this.#opts.logRaw) process.stderr.write(`[server->client] ${line}\n`);
      let msg: CodexFrame;
      try {
        msg = JSON.parse(line) as CodexFrame;
      } catch {
        // app-server emits only JSONL; banners/logs are ignored.
        continue;
      }
      this.#route(msg);
    }
  }

  #route(msg: CodexFrame): void {
    const anyMsg = msg as { id?: number | string; method?: string };
    // Response to one of our requests: has id, no method.
    if (anyMsg.id !== undefined && anyMsg.method === undefined) {
      const entry = this.#pending.get(anyMsg.id);
      if (!entry) return;
      this.#pending.delete(anyMsg.id);
      const res = msg as { error?: { message?: string }; result?: unknown };
      if (res.error)
        entry.reject(
          Object.assign(new Error(res.error.message ?? 'rpc error'), { rpc: res.error }),
        );
      else entry.resolve(res.result);
      return;
    }
    // Server-initiated REQUEST (method + id): we must reply.
    if (anyMsg.method !== undefined && anyMsg.id !== undefined) {
      const req = Object.freeze(msg) as CodexRequest;
      this.#bus.emit('serverRequest', req);
      void this.#handleServerRequest(req);
      return;
    }
    // Notification (method, no id).
    if (anyMsg.method !== undefined) {
      const frozen = Object.freeze(msg) as CodexNotification;
      this.#notifications.push(frozen);
      this.#bus.emit('notification', frozen);
      this.#bus.emit(`notify:${frozen.method}`, frozen);
      this.#opts.onNotification?.(frozen);
    }
  }

  async #handleServerRequest(req: CodexRequest): Promise<void> {
    const handler = this.#opts.onServerRequest;
    try {
      const result = handler ? await handler(req) : {};
      this.#write({ id: req.id, result });
    } catch (e) {
      this.#write({
        id: req.id,
        error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  #write(obj: unknown): void {
    if (this.#closed) throw new Error('cannot write: app-server is closed');
    this.#proc.write(JSON.stringify(obj) + '\n');
  }

  // ── client → server ──────────────────────────────────────────────────────

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.#nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#write(payload);
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  /** Reply to a held server-request by id (HITL resolution path). */
  reply(id: number | string, result: unknown): void {
    this.#write({ id, result });
  }

  replyError(id: number | string, message: string): void {
    this.#write({ id, error: { code: -32000, message } });
  }

  waitFor(
    method: string,
    predicate?: (n: CodexNotification) => boolean,
    timeoutMs = 120_000,
  ): Promise<CodexNotification> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#bus.off(`notify:${method}`, onNote);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      const onNote = (n: CodexNotification) => {
        if (predicate && !predicate(n)) return;
        clearTimeout(timer);
        this.#bus.off(`notify:${method}`, onNote);
        resolve(n);
      };
      this.#bus.on(`notify:${method}`, onNote);
    });
  }

  on(event: 'notification' | 'serverRequest' | 'exit', fn: (...args: never[]) => void): this {
    this.#bus.on(event, fn as (...args: unknown[]) => void);
    return this;
  }

  off(event: string, fn: (...args: never[]) => void): this {
    this.#bus.off(event, fn as (...args: unknown[]) => void);
    return this;
  }

  get notifications(): CodexNotification[] {
    return this.#notifications.slice();
  }

  get pid(): number | string {
    return this.#proc.pid;
  }

  close(): void {
    if (this.#closed) return;
    this.#proc.kill();
  }
}

/** Standard handshake: initialize → initialized. Returns InitializeResult. */
export async function handshake(
  client: CodexClient,
  clientInfo: Partial<InitializeParams['clientInfo']> = {},
): Promise<InitializeResult> {
  const result = await client.request<InitializeResult>(CODEX.initialize, {
    clientInfo: {
      name: clientInfo.name ?? 'render',
      version: clientInfo.version ?? '0.0.1',
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: null,
    },
  });
  client.notify(CODEX.initialized);
  return result;
}
