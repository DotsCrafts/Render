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
import { RENDER_CONTEXT_ID, errorToResult, helloFrame } from './protocol.js';
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

export interface BridgeDeps {
  /** Owns + leases the CDP targets the bridge drives. */
  provider: TargetProvider;
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

  const onMessage = async (socket: WebSocket, raw: string): Promise<void> => {
    let cmd: CommandFrame;
    try {
      cmd = JSON.parse(raw) as CommandFrame;
    } catch (err) {
      reportError(new Error(`unparseable /ext frame: ${String(err)}`));
      return;
    }
    record('RX', cmd);
    let result: ResultFrame;
    try {
      result = await dispatch(deps.provider, cmd, deps.caps ?? {});
    } catch (err) {
      result = errorToResult(cmd.id, err);
    }
    record('TX', result);
    send(socket, result);
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
