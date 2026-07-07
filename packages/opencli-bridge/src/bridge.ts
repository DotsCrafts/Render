/**
 * OpencliBridge — the `/ext` WebSocket *client* to the opencli daemon.
 *
 * The daemon is the WS *server* (ws://127.0.0.1:19825/ext); the browser extension
 * — and now Render — is the client. Registering an existing contextId evicts the
 * previous socket on that contextId, so our `hello` makes Render the profile the
 * CLI resolves. From then on the daemon forwards every CLI `/command` body to us
 * as a Command frame; we drive Render's Chromium and answer with a Result frame,
 * correlated by `id`.
 *
 * Lifecycle: connect → hello → serve. On close we re-hello on reconnect (a
 * daemon/CLI version mismatch force-restarts the daemon, not us). The bridge owns
 * no CDP logic itself — it delegates to `dispatch` against an injected
 * `TargetProvider`, keeping transport swappable.
 */

import { WebSocket } from 'ws';
import { dispatch, type DispatchCaps } from './actions.js';
import { createDispatchLanes } from './dispatch-lanes.js';
import { RENDER_CONTEXT_ID, errorToResult, fail, helloFrame } from './protocol.js';
import { leaseKeyForCommand, type SessionLeaseRegistry } from './session-registry.js';
import type {
  CommandFrame,
  FrameRecord,
  HelloFrame,
  ResultFrame,
  TargetProvider,
} from './types.js';

const DEFAULT_DAEMON_URL = 'ws://127.0.0.1:19825/ext';
const RECONNECT_DELAY_MS = 1_000;
/** Max time stop() waits for the daemon to ACK our close (unregister our profile). */
const CLOSE_GRACE_MS = 2_000;
/**
 * Hard bound on a single dispatch. Every op is already individually bounded
 * (navigate/eval timeouts), but a CDP send against a wedged renderer can hang
 * past all of them; the deadline answers the daemon with a failure and frees
 * the lane so one stuck command can't stall its session (or, for exclusive
 * ops, everyone). Honors the frame's `timeout` field (seconds, capped at MAX);
 * defaults when absent. The abandoned dispatch keeps running detached — its
 * late result is discarded (the daemon has already been answered for that id).
 */
const DISPATCH_DEADLINE_DEFAULT_MS = 45_000;
const DISPATCH_DEADLINE_MAX_MS = 60_000;

export interface BridgeDeps {
  /**
   * Owns + leases the CDP targets the bridge drives. Pass a
   * `SessionLeaseRegistry` to partition leases per opencli session (each
   * command is served from its own session's partition, and `close-window`
   * only releases the calling session's leases). A plain `TargetProvider`
   * keeps the legacy shared-lease behaviour.
   */
  provider: TargetProvider | SessionLeaseRegistry;
  /**
   * Multi-lease capabilities (network capture buffer, download routing). Omitted
   * for a single-lease bridge — the multi-lease actions then fail loudly.
   */
  caps?: DispatchCaps;
  /** Daemon `/ext` URL (default ws://127.0.0.1:19825/ext). */
  daemonUrl?: string;
  /**
   * The contextId to register as. Defaults to `"render"` — Render's OWN, distinct
   * profile. It MUST differ from the system-Chrome extension's contextId
   * (`3k59e8nw`), otherwise the daemon evicts whichever connected first and we are
   * back to the M1 quit-Chrome behaviour. opencli targets us with
   * `--profile render` / `OPENCLI_PROFILE=render`.
   */
  contextId?: string;
  /** Auto re-connect + re-hello when the daemon drops us (default true). */
  autoReconnect?: boolean;
  /** Override the per-command dispatch deadline (default 45 s; tests only). */
  dispatchDeadlineMs?: number;
  /** Called after every successful socket open + hello, including reconnects. */
  onConnect?: () => void;
  /** Observe every wire frame (TX/RX) — the harness uses this for evidence. */
  onFrame?: (record: FrameRecord) => void;
  /** Non-fatal diagnostics (no console.log noise inside the package). */
  onError?: (err: Error) => void;
}

export interface BridgeHandle {
  /** Connect, send hello, and start serving. Resolves once `hello` is sent. */
  start(): Promise<void>;
  /** Stop serving + dispose leased targets. Idempotent. */
  stop(): Promise<void>;
  /** Whether the `/ext` socket is currently open. */
  readonly connected: boolean;
}

export function createOpencliBridge(deps: BridgeDeps): BridgeHandle {
  const daemonUrl = deps.daemonUrl ?? DEFAULT_DAEMON_URL;
  const contextId = deps.contextId ?? RENDER_CONTEXT_ID;
  const autoReconnect = deps.autoReconnect ?? true;

  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const now = (): string => new Date().toISOString();
  const record = (dir: 'TX' | 'RX', frame: HelloFrame | CommandFrame | ResultFrame): void => {
    deps.onFrame?.({ ts: now(), dir, frame });
  };
  const reportError = (err: unknown): void => {
    deps.onError?.(err instanceof Error ? err : new Error(String(err)));
  };

  const send = (socket: WebSocket, frame: ResultFrame | HelloFrame): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  };

  // Commands are dispatched through LANES. Originally everything ran through
  // one global FIFO — safe (concurrent dispatch against shared lease state was
  // the root cause of "first few commands work, then everything hangs") but a
  // waterfall: one session's slow navigate stalled every other session. With a
  // SessionLeaseRegistry the leases are partitioned per session, so commands
  // from different sessions run concurrently (FIFO within a session), while
  // lease-MUTATING ops (`tabs new/select/close`, `close-window`) — which touch
  // the shared Electron tab host — keep an exclusive global lane. A plain
  // TargetProvider shares lease state across sessions, so it keeps the strict
  // global FIFO (every command exclusive). Each dispatch is additionally
  // bounded by the deadline so no single command can wedge its lane.
  const lanes = createDispatchLanes();
  const registry = isSessionRegistry(deps.provider) ? deps.provider : null;
  const plainProvider = registry ? null : (deps.provider as TargetProvider);

  /** Deadline for one dispatch: the frame's `timeout` (seconds, capped), or the configured default. */
  const cmdDeadline = (cmd: CommandFrame): { ms: number; fromCmd: boolean } => {
    const seconds = typeof cmd.timeout === 'number' && cmd.timeout > 0 ? cmd.timeout : undefined;
    if (seconds !== undefined)
      return { ms: Math.min(seconds * 1000, DISPATCH_DEADLINE_MAX_MS), fromCmd: true };
    return { ms: deps.dispatchDeadlineMs ?? DISPATCH_DEADLINE_DEFAULT_MS, fromCmd: false };
  };

  const onMessage = (socket: WebSocket, raw: string): Promise<void> => {
    let cmd: CommandFrame;
    try {
      cmd = JSON.parse(raw) as CommandFrame;
    } catch (err) {
      reportError(new Error(`unparseable /ext frame: ${String(err)}`));
      return Promise.resolve();
    }
    record('RX', cmd);
    const run = async (): Promise<void> => {
      let result: ResultFrame;
      try {
        const provider = registry ? registry.providerFor(cmd) : plainProvider!;
        const { ms, fromCmd } = cmdDeadline(cmd);
        result = await withDeadline(cmd.id, ms, fromCmd, dispatch(provider, cmd, deps.caps ?? {}));
        // completion counts as activity too, so a command longer than the idle
        // timeout doesn't get its session reaped right at the finish line.
        registry?.touch(cmd);
      } catch (err) {
        result = errorToResult(cmd.id, err);
      }
      record('TX', result);
      send(socket, result);
    };
    const laneKey = registry ? leaseKeyForCommand(cmd) : '';
    const exclusive = !registry || isLeaseMutating(cmd);
    return lanes.enqueue(laneKey, exclusive, run);
  };

  const scheduleReconnect = (): void => {
    if (stopped || !autoReconnect || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open().catch(reportError);
    }, RECONNECT_DELAY_MS);
  };

  const open = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      // A `chrome-extension://` Origin passes the daemon's verifyClient gate even
      // if it ever tightens; Node `ws` also sends no Origin (which already passes).
      const socket = new WebSocket(daemonUrl, {
        headers: { Origin: `chrome-extension://renderopenclibridge${contextId}` },
      });
      ws = socket;

      socket.on('open', () => {
        const hello = helloFrame(contextId);
        record('TX', hello);
        send(socket, hello);
        try {
          deps.onConnect?.();
        } catch (err) {
          reportError(err);
        }
        resolve();
      });
      socket.on('message', (data) => void onMessage(socket, data.toString()));
      socket.on('error', (err) => {
        reportError(err);
        reject(err);
      });
      socket.on('close', () => {
        if (ws === socket) ws = null;
        scheduleReconnect();
      });
    });

  const start = async (): Promise<void> => {
    stopped = false;
    await open();
  };

  // Resolve once the socket is fully CLOSED so the daemon has run its `ws.on('close')`
  // handler — that is what `unregisterExtensionConnection` runs to remove OUR profile
  // from `extensionProfiles`. Without awaiting this, a fast process exit can strand the
  // profile and leave the daemon showing a ghost (`none selected`). We mark `stopped`
  // first so the close handler does NOT schedule a reconnect (which would re-register us).
  const closeSocket = (socket: WebSocket): Promise<void> =>
    new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // Daemon never ACKed the close in time — force the underlying socket shut so
        // the FIN still reaches the daemon, then give up waiting.
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        done();
      }, CLOSE_GRACE_MS);
      socket.once('close', done);
      try {
        socket.close();
      } catch {
        done();
      }
    });

  const stop = async (): Promise<void> => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const socket = ws;
    ws = null;
    if (socket) {
      await closeSocket(socket);
    }
    await deps.provider.dispose();
  };

  return {
    start,
    stop,
    get connected(): boolean {
      return ws?.readyState === WebSocket.OPEN;
    },
  };
}

function isSessionRegistry(
  p: TargetProvider | SessionLeaseRegistry,
): p is SessionLeaseRegistry {
  return typeof (p as Partial<SessionLeaseRegistry>).providerFor === 'function';
}

/** `tabs` ops that create/destroy/re-point real views through the shared tab host. */
const LEASE_MUTATING_TAB_OPS: ReadonlySet<string> = new Set(['new', 'select', 'close']);

/** Whether a command mutates lease/view state and must take the exclusive lane. */
function isLeaseMutating(cmd: CommandFrame): boolean {
  if (cmd.action === 'close-window') return true;
  if (cmd.action !== 'tabs') return false;
  // `tabs` with no op defaults to `list` (read-only) in the action handler.
  return typeof cmd.op === 'string' && LEASE_MUTATING_TAB_OPS.has(cmd.op);
}

/** Race a dispatch against the deadline; on expiry answer with a failure frame. */
function withDeadline(
  id: string,
  ms: number,
  fromCmd: boolean,
  work: Promise<ResultFrame>,
): Promise<ResultFrame> {
  // If the deadline wins, `work` is abandoned; pre-handle its rejection so a
  // late failure can't surface as an unhandled rejection.
  void work.catch(() => {});
  let timer: NodeJS.Timeout;
  const deadline = new Promise<ResultFrame>((resolve) => {
    timer = setTimeout(() => {
      // Distinguish the source so callers can tell whether the command's own
      // timeout was exceeded (result unknown — the browser may have acted) vs.
      // the bridge's safety deadline (dispatch_deadline — internal watermark).
      const result = fromCmd
        ? fail(
            id,
            `command timed out after ${Math.round(ms / 1000)}s — ` +
              'the browser may still have executed it (result unknown)',
            { errorCode: 'timeout' },
          )
        : fail(id, `dispatch deadline exceeded after ${ms}ms`, { errorCode: 'dispatch_deadline' });
      resolve(result);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
