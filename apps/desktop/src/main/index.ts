/**
 * Render main process — the trusted hands broker.
 *
 * Hosts a BrowserWindow whose base layer is the chrome renderer (tab strip,
 * omnibox, right agent panel, bottom floating input) and adds page
 * WebContentsViews on top, inset to the content rect. Wires the IPC broker, the
 * CDP human-hand (+ relay), and a TEMPORARY agent stub.
 */

import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createHumanHand } from '@render/cdp-human-hand';
import { selectSandbox } from '@render/sandbox';
import { createOpencliRouter } from '@render/opencli-router';
import { TabManager } from './tabs.js';
import { createAgentRuntime } from './agent-runtime.js';
import { registerIpc } from './ipc.js';
import { runCdpSelfTest } from './cdp-selftest.js';
import { enableRenderCdp } from './cdp-port.js';
import { registerRenderOpencliApp } from './opencli-render-app.js';
import { maybeWireOpencliBridge, renderBridgeProfile } from './opencli-bridge-wire.js';
import { createCodexProvider } from './codex-provider.js';

// electron-vite emits this module as CommonJS, so `__dirname` is available.

// Open Render's OWN CDP endpoint (loopback) BEFORE app startup so opencli can
// drive Render's embedded Chromium over CDP instead of system Chrome.
const renderCdp = enableRenderCdp();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'Render',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));

  return win;
}

function wire(win: BrowserWindow): void {
  const tabs = new TabManager({
    window: win,
    onChange: (snapshot) => broker.emitTabs(snapshot),
  });

  const humanHand = createHumanHand({
    getTarget: (tabId) => tabs.getTarget(tabId),
    createTab: async (url) => tabs.create(url),
    listTabs: () => tabs.listTabs(),
  });

  // App hand: opencli adapters run in their own sandbox (public/API) and route
  // browser/cookie adapters to the real logged-in Chromium via the CDP relay.
  const router = createOpencliRouter({ sandbox: selectSandbox(), humanHand });

  // The opencli bridge serves cookie/browser adapters from Render's OWN Chromium
  // (default ON; set RENDER_OPENCLI_BRIDGE=0 to disable). The agent's opencli must
  // target Render's profile so dianping/taobao/… drive Render's views (which share
  // the user's logged-in session) instead of system Chrome.
  const bridgeEnabled = process.env.RENDER_OPENCLI_BRIDGE !== '0';
  const bridgeProfile = bridgeEnabled ? renderBridgeProfile() : undefined;

  // Codex provider/auth (Phase A): Render owns model-provider config + creds.
  // When a Render credential exists, the runtime uses a CODEX_HOME materialized
  // from it instead of copying the user's ~/.codex.
  const codexProvider = createCodexProvider();

  // Brain: codex app-server runs in a SECOND sandbox owned by the runtime.
  const agent = createAgentRuntime({
    emit: (event) => broker.emitAgent(event),
    sandbox: selectSandbox(),
    router,
    // give the BRAIN a CDP endpoint for its own opencli browser-adapter calls.
    // Locally, that's Render's OWN embedded Chromium (--remote-debugging-port);
    // `opencli render <cmd>` then drives Render's tabs, never system Chrome. If
    // the port is disabled, fall back to the human-hand relay (remote/e2b seam).
    cdpEndpoint: async () => (renderCdp.enabled ? renderCdp.endpoint : humanHand.cdpEndpoint()),
    // the `render-open` tool: open a page in Render's OWN browser, not system Chrome.
    // tabs.openUrl emits a tabsChanged snapshot via the manager's onChange.
    openTab: (url) => tabs.openUrl(url),
    // register each conversation's tab group (label/color) when it becomes active
    // so the strip can chip it even before the bridge mints its first tab.
    registerGroup: (group) => tabs.ensureGroup(group),
    // route the agent's cookie/browser opencli calls to Render's bridge profile.
    opencliProfile: bridgeProfile,
    // prefer a Render-managed CODEX_HOME (provider + creds from settings).
    materializeCodexHome: () => codexProvider.materializeCodexHome(),
    now: () => Date.now(),
  });

  const broker = registerIpc({ chrome: win.webContents, tabs, agent, humanHand, codex: codexProvider });

  // Serve opencli's /ext browser backend from Render's OWN Chromium (default ON;
  // RENDER_OPENCLI_BRIDGE=0 disables). Cookie/browser adapters then run inside
  // Render as REAL tabs in the agent's owned tab group: `<site> login` opens a
  // visible tab the user logs into, and because every bridge tab shares the
  // `persist:render` session, that login authenticates the agent's commands.
  // Bridge tabs join the CURRENT conversation's group, read at mint time from the
  // agent runtime (new group ⟺ new conversation). The runtime is the conversation
  // owner — it allocates groups and starts fresh codex threads in lockstep.
  const opencliBridge = bridgeEnabled
    ? maybeWireOpencliBridge({ tabs, activeGroup: () => agent.activeGroup() })
    : null;

  // Guard the chrome shell: a link clicked inside the agent panel must NEVER
  // replace the app UI. Any top-level navigation away from the renderer origin
  // is cancelled and opened as a real Render browsing tab instead.
  const chromeOrigin = (() => {
    const u = process.env.ELECTRON_RENDERER_URL;
    if (!u) return null;
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  })();
  const isChromeNav = (url: string): boolean => {
    if (url.startsWith('file://') || url === 'about:blank') return true;
    if (!chromeOrigin) return false;
    try {
      return new URL(url).origin === chromeOrigin;
    } catch {
      return false;
    }
  };
  win.webContents.on('will-navigate', (e, url) => {
    if (isChromeNav(url)) return; // allow the SPA's own loads + HMR
    e.preventDefault();
    tabs.openUrl(url); // replace a blank tab, else open a new one (traditional)
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url !== 'about:blank') void tabs.create(url); // window.open → new tab
    return { action: 'deny' };
  });

  // keep page views inset correctly as the window resizes
  win.on('resize', () => tabs.relayout());

  // open the first (blank) browsing tab once the chrome is ready
  win.webContents.once('did-finish-load', () => {
    if (tabs.activeTabId === null) tabs.create();
    // CDP self-test is a dev diagnostic (opens example.com) — off by default.
    if (process.env.RENDER_DEBUG_CDP) void runCdpSelfTest(humanHand, tabs);
  });

  win.on('closed', () => {
    broker.dispose();
    void agent.dispose();
    void router.dispose();
    tabs.dispose();
    void humanHand.dispose();
    void opencliBridge?.dispose();
    void codexProvider.dispose();
  });
}

app.whenReady().then(() => {
  // Register Render as an opencli Electron app so `opencli render <cmd>` routes
  // to Render's embedded Chromium over CDP. Best-effort, idempotent, additive.
  if (renderCdp.enabled) {
    void registerRenderOpencliApp({ port: renderCdp.port }).then((r) => {
      if (!r.registered) console.warn('[render-cdp] opencli app registration skipped:', r.note);
    });
  }

  const win = createWindow();
  wire(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createWindow();
      wire(next);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
