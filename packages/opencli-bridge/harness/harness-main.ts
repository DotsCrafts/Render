/**
 * Standalone Electron verification harness for @render/opencli-bridge (Milestone 1).
 *
 * This is NOT the Render app. It is the smallest possible Electron process that
 * exercises the REAL bridge against the REAL opencli daemon:
 *
 *   1. boots a hidden BaseWindow + a single WebContentsView (the bridge's leased
 *      surface — Render's OWN Chromium, not system Chrome),
 *   2. starts the bridge as contextId `render` (Render's OWN, distinct profile —
 *      NOT the system-Chrome `3k59e8nw`), so it coexists with system Chrome and
 *      the CLI resolves US only when targeting `--profile render`,
 *   3. writes every `/ext` wire frame to an ndjson evidence log,
 *   4. signals readiness (a sentinel line on stdout) so the runner can fire
 *      `opencli google search` and assert the results came through THIS view.
 *
 * The window is never shown and is off the user's screen — it must not disturb a
 * running Render dev app or the user's desktop. We import `electron` only here,
 * in the harness, so the library package stays Electron-free.
 */

import { app, BaseWindow, WebContentsView } from 'electron';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createOpencliBridge } from '../src/bridge.js';
import { createWebContentsLeaseProvider } from '../src/view-provider.js';
import type { FrameRecord } from '../src/types.js';
import type { WcContents } from '../src/webcontents-target.js';

const CONTEXT_ID = process.env.BRIDGE_CONTEXT_ID ?? 'render';
const FRAME_LOG = process.env.BRIDGE_FRAME_LOG ?? resolve(process.cwd(), 'harness/evidence/frames.ndjson');
const READY_SENTINEL = '__BRIDGE_READY__';

// Truncate huge strings (scraped HTML / screenshots) so the evidence log stays
// readable while still proving the real wire shape.
const truncate = (record: FrameRecord): unknown =>
  JSON.parse(
    JSON.stringify(record, (_k, v) =>
      typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}…[+${v.length - 600} chars]` : v,
    ),
  );

async function main(): Promise<void> {
  await app.whenReady();

  // A real, off-screen window so the WebContentsView has a host. show:false keeps
  // it invisible; we also park it far off any plausible display.
  const win = new BaseWindow({ width: 1280, height: 900, show: false, x: -4000, y: -4000 });
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: false },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });

  let viewClosed = false;
  const provider = createWebContentsLeaseProvider({
    mintView: () => ({
      // The harness leases the single pre-built view (single-lease M1). A real
      // multi-lease build would mint a fresh view per call here.
      webContents: view.webContents as unknown as WcContents,
      destroy: () => {
        if (viewClosed) return;
        viewClosed = true;
        try {
          win.contentView.removeChildView(view);
          view.webContents.close();
        } catch {
          /* already gone */
        }
      },
    }),
  });

  mkdirSync(dirname(FRAME_LOG), { recursive: true });
  const frameLog = createWriteStream(FRAME_LOG, { flags: 'w' });

  const bridge = createOpencliBridge({
    provider,
    contextId: CONTEXT_ID,
    onFrame: (record) => {
      frameLog.write(`${JSON.stringify(truncate(record))}\n`);
      // A compact line on stdout so the runner can tail the conversation live.
      process.stdout.write(`[${record.dir}] ${JSON.stringify(record.frame).slice(0, 200)}\n`);
    },
    onError: (err) => process.stderr.write(`[bridge-error] ${err.message}\n`),
  });

  await bridge.start();
  // Readiness sentinel: we are registered as the daemon profile and serving.
  process.stdout.write(`${READY_SENTINEL} contextId=${CONTEXT_ID} log=${FRAME_LOG}\n`);

  const shutdown = async (): Promise<void> => {
    await bridge.stop();
    frameLog.end();
    app.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  process.stderr.write(`[harness-fatal] ${err instanceof Error ? err.stack : String(err)}\n`);
  app.exit(1);
});
