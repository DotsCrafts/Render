/**
 * ux-confirm-broker — the Render-side confirm surface for generated-page WRITES.
 *
 * A loopback HTTP endpoint + random token that Render injects into the
 * opencli-ux kernel (env OPENCLI_UX_CONFIRM_URL / OPENCLI_UX_CONFIRM_TOKEN).
 * For every write-granted /ux/data invocation the kernel POSTs
 * {site,command,positional,args,session} here and only runs the command on
 * {"allow":true}. `requestConfirm` is wired by the agent-runtime to the
 * existing HITL machinery: it emits a blocking ux confirm card and resolves
 * with the human's choice (resolveUx). Fail closed everywhere: bad token, bad
 * body, or a rejected/errored confirm all answer {"allow":false}.
 *
 * Lazy: the server binds on the first endpoint() call — read-only pages never
 * start it.
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';

/** What the kernel asks Render to approve (one write invocation). */
export interface UxWriteRequest {
  site: string;
  command: string;
  positional?: unknown[];
  args?: Record<string, unknown>;
  /** the ux server session that asked — maps back to the page (title) */
  session?: string;
}

export interface UxConfirmBroker {
  /** Start (once) and return the injectable endpoint, or null if it can't bind. */
  endpoint(): Promise<{ url: string; token: string } | null>;
  dispose(): void;
}

export function createUxConfirmBroker(deps: {
  /** resolve true ⇔ the human approved this write (never throws to the kernel) */
  requestConfirm: (req: UxWriteRequest) => Promise<boolean>;
}): UxConfirmBroker {
  let server: http.Server | null = null;
  let starting: Promise<{ url: string; token: string } | null> | null = null;
  const token = randomBytes(24).toString('base64url');

  const answer = (res: http.ServerResponse, code: number, allow: boolean, reason?: string): void => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(reason ? { allow, reason } : { allow }));
  };

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.method !== 'POST') return answer(res, 405, false, 'POST only');
    if (req.headers['x-ux-confirm-token'] !== token) return answer(res, 403, false, 'bad token');
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let body: UxWriteRequest;
      try {
        body = JSON.parse(buf || '{}') as UxWriteRequest;
      } catch {
        return answer(res, 400, false, 'bad json');
      }
      if (!body || typeof body.site !== 'string' || typeof body.command !== 'string' || !body.site || !body.command) {
        return answer(res, 400, false, 'site and command required');
      }
      deps
        .requestConfirm(body)
        .then((allow) => answer(res, 200, allow === true))
        .catch((err) => answer(res, 200, false, `confirm failed: ${String(err)}`));
    });
  };

  const endpoint: UxConfirmBroker['endpoint'] = () => {
    if (!starting) {
      starting = new Promise((resolve) => {
        const s = http.createServer(handle);
        s.once('error', (err) => {
          console.warn('[ux-confirm-broker] failed to bind:', String(err));
          resolve(null);
        });
        s.listen(0, '127.0.0.1', () => {
          server = s;
          const addr = s.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          resolve({ url: `http://127.0.0.1:${port}/`, token });
        });
      });
    }
    return starting;
  };

  return {
    endpoint,
    dispose() {
      try {
        server?.close();
      } catch {
        /* already gone */
      }
      server = null;
      starting = null;
    },
  };
}
