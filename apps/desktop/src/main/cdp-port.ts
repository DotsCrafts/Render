/**
 * Render's own CDP endpoint (Approach B — native CDP, no extension bridge).
 *
 * The problem: opencli's browser automation drives whatever Chrome has its
 * extension bridge installed — by default the user's SYSTEM Chrome, not Render's
 * embedded Chromium. opencli only takes its direct-CDP code path for sites
 * registered as "Electron apps"; for those it connects to a real Chrome
 * DevTools endpoint (`http://127.0.0.1:<port>/json`).
 *
 * So we launch Render's Electron with `--remote-debugging-port`, register Render
 * as an opencli Electron app (see opencli-render-app.ts), and point the agent's
 * `OPENCLI_CDP_ENDPOINT` here. `opencli render <cmd>` then drives Render's OWN
 * tabs over CDP and never crosses to system Chrome.
 *
 * Security: Chromium binds the debugging port to loopback (127.0.0.1) only.
 * `--remote-allow-origins=*` is required so a non-DevTools WebSocket client (the
 * opencli CDP client, which sends no Origin header) can attach to the loopback
 * port. Disable the whole thing with `RENDER_NO_CDP=1`.
 *
 * MUST be called at module top level, BEFORE `app.whenReady()` — command-line
 * switches are read by Chromium during startup.
 */

import { app } from 'electron';

const DEFAULT_PORT = 9333;

export interface RenderCdp {
  /** whether the debugging port is active */
  enabled: boolean;
  /** the loopback port Render's Chromium listens on */
  port: number;
  /** the http CDP endpoint opencli targets, e.g. http://127.0.0.1:9333 */
  endpoint: string;
}

const portFromArgv = (): number | null => {
  const arg = process.argv.find((a) => a.startsWith('--remote-debugging-port'));
  if (!arg) return null;
  const raw = arg.includes('=') ? arg.split('=')[1] : '';
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function enableRenderCdp(): RenderCdp {
  const port = portFromArgv() ?? (Number(process.env.RENDER_CDP_PORT) || DEFAULT_PORT);
  const endpoint = `http://127.0.0.1:${port}`;

  if (process.env.RENDER_NO_CDP === '1') {
    return { enabled: false, port, endpoint };
  }

  // Respect an externally-supplied port (e.g. the e2e harness) — appending a
  // second --remote-debugging-port would conflict. Only add ours if none given.
  if (portFromArgv() === null) {
    app.commandLine.appendSwitch('remote-debugging-port', String(port));
  }
  // Allow the headerless opencli CDP WebSocket client to attach (loopback only).
  app.commandLine.appendSwitch('remote-allow-origins', '*');

  return { enabled: true, port, endpoint };
}
