/**
 * CdpRelay — a real, reachable local CDP relay endpoint (reverse-proxy seam).
 *
 * Why this exists (the "client-pull iron law"): the BRAIN runs inside a sandbox
 * that is credential-blind. When it needs a logged-in site it must NOT get the
 * cookies — instead it drives the user's real Chromium tab from a distance. This
 * relay is that seam: a remote sandbox connects to `ws://127.0.0.1:<port>` (or a
 * tunnel of it) and speaks CDP; the relay forwards each command to the in-process
 * `webContents.debugger` and streams the debugger's events back. Plane-2 auth
 * never leaves the device — only CDP traffic crosses the wire.
 *
 * For the local prototype the relay proxies straight to the in-process debugger.
 * For e2b the SAME endpoint is exposed over a tunnel; nothing else changes.
 *
 * Transport (one JSON object per ws frame):
 *   client → relay : { id, method, params?, tabId? }            (a CDP command)
 *   relay  → client : { id, result } | { id, error }            (command reply)
 *   relay  → client : { method, params, tabId }                 (a CDP event)
 *
 * Discovery (HTTP, Chrome-DevTools convention so standard tooling can attach):
 *   GET /json/version → { Browser, webSocketDebuggerUrl, ... }
 *   GET /json[/list]  → [{ id, title, url, webSocketDebuggerUrl }, ...]
 *   GET /health       → { ok: true }
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RelayCommand, RelayTarget } from './types.js';

export interface RelayDeps {
  host: string;
  port: number;
  /** Execute a CDP command against the right tab; returns the CDP result. */
  handleCommand(cmd: RelayCommand): Promise<unknown>;
  /** Current attachable targets, for discovery endpoints. */
  listTargets(): RelayTarget[];
}

export interface RelayAddress {
  host: string;
  port: number;
  wsUrl: string;
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

export class CdpRelay {
  private readonly deps: RelayDeps;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private address: RelayAddress | null = null;

  constructor(deps: RelayDeps) {
    this.deps = deps;
  }

  /** Idempotent: returns the live address if already started. */
  async start(): Promise<RelayAddress> {
    if (this.address) return this.address;

    const http = createServer((req, res) => this.onHttp(req, res));
    const wss = new WebSocketServer({ noServer: true });

    http.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    wss.on('connection', () => {});

    this.http = http;
    this.wss = wss;

    const { host, port } = this.deps;
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, host, () => {
        http.off('error', reject);
        resolve();
      });
    });

    const addr = http.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    this.address = { host, port: boundPort, wsUrl: `ws://${host}:${boundPort}` };
    return this.address;
  }

  get url(): string | null {
    return this.address?.wsUrl ?? null;
  }

  /** Push a CDP event to every connected relay client. */
  broadcastEvent(method: string, params: unknown, tabId: string): void {
    if (this.clients.size === 0) return;
    const frame = JSON.stringify({ method, params, tabId });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  }

  async close(): Promise<void> {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
    this.http = null;
    this.wss = null;
    this.address = null;
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('message', (data) => void this.onMessage(ws, data.toString()));
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let cmd: RelayCommand;
    try {
      cmd = JSON.parse(raw) as RelayCommand;
    } catch {
      ws.send(JSON.stringify({ error: { message: 'invalid JSON frame' } }));
      return;
    }
    if (typeof cmd.method !== 'string') {
      ws.send(JSON.stringify({ id: cmd.id, error: { message: 'missing method' } }));
      return;
    }
    try {
      const result = await this.deps.handleCommand(cmd);
      ws.send(JSON.stringify({ id: cmd.id, result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ id: cmd.id, error: { message } }));
    }
  }

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health') {
      json(res, 200, { ok: true });
      return;
    }
    if (path === '/json/version') {
      json(res, 200, {
        Browser: 'Render/0.1 (human-hand relay)',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: this.address?.wsUrl ?? '',
      });
      return;
    }
    if (path === '/json' || path === '/json/list') {
      const base = this.address?.wsUrl ?? '';
      json(
        res,
        200,
        this.deps.listTargets().map((t) => ({
          id: t.tabId,
          type: 'page',
          title: t.title,
          url: t.url,
          webSocketDebuggerUrl: `${base}?tabId=${encodeURIComponent(t.tabId)}`,
        })),
      );
      return;
    }
    json(res, 404, { error: 'not found' });
  }
}
