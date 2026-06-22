/**
 * Codex egress injection proxy (local) — keep the model key out of the brain.
 *
 * In local-seatbelt mode codex normally reads the API key from CODEX_HOME's
 * auth.json (plaintext) and sets `Authorization` itself — so the agentic brain,
 * which also runs model-driven shell commands, holds the raw key.
 *
 * This is a loopback REVERSE proxy that removes that exposure WITHOUT MITM/CA:
 *   - codex's provider base_url points at http://127.0.0.1:PORT (this server).
 *   - codex carries only a DUMMY key (its auth.json placeholder).
 *   - on each request we strip codex's Authorization, inject the REAL bearer
 *     (held only in Render's main process), and forward over TLS to the real
 *     upstream (e.g. https://api.ai.ifunk.cn or https://api.openai.com/v1).
 *
 * The loopback hop is plaintext but never leaves the machine and carries only
 * the dummy key; the real key is added only on the outbound TLS leg. Streaming
 * (SSE/responses) is preserved by piping bodies through untouched.
 */

import { createServer, request as httpRequest, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

export interface EgressTarget {
  /** real upstream base URL, e.g. https://api.ai.ifunk.cn or https://api.openai.com/v1 */
  upstream: string;
  /** the real bearer credential to inject (never reaches codex) */
  bearer: string;
}

export interface CodexEgressProxy {
  /** local base URL codex uses as its provider base_url */
  readonly url: string;
  /** point the proxy at an upstream + credential (call before each session) */
  setTarget(t: EgressTarget): void;
  dispose(): Promise<void>;
}

/** Hop-by-hop / identity headers we must not forward upstream verbatim. */
const STRIP = new Set(['host', 'authorization', 'proxy-connection', 'connection']);

export async function createCodexEgressProxy(): Promise<CodexEgressProxy> {
  let target: EgressTarget | null = null;

  const server: Server = createServer((req, res) => {
    if (!target) {
      res.statusCode = 503;
      res.end('codex egress proxy not configured');
      return;
    }
    let up: URL;
    try {
      // base_url + the path codex appended (e.g. "/responses")
      up = new URL(target.upstream.replace(/\/+$/, '') + (req.url ?? ''));
    } catch (e) {
      res.statusCode = 502;
      res.end(`bad upstream: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const isHttps = up.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !STRIP.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = up.host;
    headers.authorization = `Bearer ${target.bearer}`; // ← the real key, injected here only

    const upReq = doRequest(
      {
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port || (isHttps ? 443 : 80),
        path: up.pathname + up.search,
        method: req.method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upReq.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`upstream error: ${e.message}`);
    });
    req.pipe(upReq);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    setTarget: (t) => {
      target = t;
    },
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
