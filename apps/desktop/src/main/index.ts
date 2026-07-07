/**
 * Render main process — the trusted hands broker.
 *
 * Hosts a BrowserWindow whose base layer is the chrome renderer (tab strip,
 * omnibox, right agent panel, bottom floating input) and adds page
 * WebContentsViews on top, inset to the content rect. Wires the real spine:
 * TabManager + IPC broker, the CDP human-hand (+ relay) and Render's own CDP
 * port, the opencli app-hand router, the /ext opencli bridge (persist:render
 * profile), the agent runtime (codex brain) with its codex provider and pages
 * store, the opencli-served home portal, and OpenCLIApp daemon warmup.
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
import {
  maybeWireOpencliBridge,
  renderBridgeProfile,
  type OpencliBridgeWire,
} from './opencli-bridge-wire.js';
import { createCodexProvider } from './codex-provider.js';
import { createPagesStore } from './pages-store.js';
import { startHomePortal, type HomePortal } from './home-portal.js';
import { resolveUxMjs, disposeUxHost } from './ux-server.js';
import { installAppMenu } from './app-menu.js';
import { ensureOpencliDaemon } from './opencli-daemon.js';

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

function wire(win: BrowserWindow, daemonReady: Promise<boolean>): void {
  // Render's home page is an opencli-served portal (started below, once daemon
  // warmup settles). Declared first so TabManager's homeUrl getter can read it
  // lazily — a tab created before the portal is up falls back to blank.
  let homePortal: HomePortal | null = null;
  let disposed = false;

  const tabs = new TabManager({
    window: win,
    onChange: (snapshot) => broker.emitTabs(snapshot),
    // default new-tab / home URL = the opencli portal (read lazily at create time).
    homeUrl: () => homePortal?.url ?? null,
  });

  const humanHand = createHumanHand({
    getTarget: (tabId) => tabs.getTarget(tabId),
    createTab: async (url) => tabs.create(url),
    listTabs: () => tabs.listTabs(),
  });

  // App hand: opencli adapters run in their own sandbox (public/API) and route
  // browser/cookie adapters to the real logged-in Chromium. Like the agent
  // runtime's cdpEndpoint below, prefer Render's OWN CDP port when it's open —
  // `/opencli` browser commands then drive Render's tabs — and fall back to the
  // human-hand relay (the remote/e2b seam) when it isn't.
  const router = createOpencliRouter({
    sandbox: selectSandbox(),
    humanHand,
    browserEndpoint: async () =>
      renderCdp.enabled ? renderCdp.endpoint : humanHand.cdpEndpoint(),
  });

  // The opencli bridge serves cookie/browser adapters from Render's OWN Chromium
  // (default ON; set RENDER_OPENCLI_BRIDGE=0 to disable). The agent's opencli must
  // target Render's profile so dianping/taobao/… drive Render's views (which share
  // the user's logged-in session) instead of system Chrome.
  const bridgeEnabled = process.env.RENDER_OPENCLI_BRIDGE !== '0';
  const bridgeProfile = bridgeEnabled ? renderBridgeProfile() : undefined;

  // Start the opencli portal server (Render's home page) once daemon warmup
  // settles — its /ux/data calls route to Render's own bridge profile, so the
  // portal's widgets read through the same logged-in session the agent uses.
  // Best-effort: disabled cleanly if unavailable. The window/tabs/agent above
  // and below wire up synchronously; ONLY the daemon-dependent pieces (portal +
  // /ext bridge) wait, so a cold daemon can no longer block the first paint.
  const portalReady: Promise<string | null> = daemonReady
    .then((ok) => {
      if (!ok) console.warn('[opencli-daemon] daemon is still unreachable after warmup');
      if (disposed) return null;
      homePortal = startHomePortal(bridgeProfile ? { profile: bridgeProfile } : {});
      return homePortal.whenReady();
    })
    .catch(() => null);

  // Codex provider/auth (Phase A): Render owns model-provider config + creds.
  // When a Render credential exists, the runtime uses a CODEX_HOME materialized
  // from it instead of copying the user's ~/.codex.
  const codexProvider = createCodexProvider();

  // Saved render-pages (Delta 3): persist delivered page specs under userData so
  // they survive the conversation/app and can be reopened (re-served) live. The
  // store re-serves through the agent runtime's servePage (declared below —
  // read lazily) so reopened pages get the same write-confirm broker and
  // page-action forwarding as freshly delivered ones, under Render's bridge
  // profile (the same logged-in session).
  let agentRef: ReturnType<typeof createAgentRuntime> | null = null;
  const pagesStore = createPagesStore({
    userDataDir: app.getPath('userData'),
    ...(bridgeProfile ? { profile: bridgeProfile } : {}),
    serve: (input) => {
      if (!agentRef) return Promise.reject(new Error('agent runtime not ready'));
      return agentRef.servePage(input);
    },
    now: () => Date.now(),
  });

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
    // tabs.openUrl emits a tabsChanged snapshot via the manager's onChange, and
    // returns the tab id so the runtime can update delivered pages in place.
    openTab: (url) => tabs.openUrl(url),
    // closing a generated page's tab must kill that page's ux server (leak fix).
    onTabClose: (cb) => tabs.onTabClose(cb),
    // update-in-place for revised render-pages: re-point (or reload, when the URL
    // is unchanged) the tab the page lives in. Deliberately does NOT activate the
    // tab — a skeleton→refine pass must not steal focus. false → tab was closed,
    // and the runtime opens a fresh one instead.
    navigateTab: (tabId, url) => {
      if (!tabs.getTarget(tabId)) return false;
      void tabs.navigate(tabId, url);
      return true;
    },
    // register each conversation's tab group (label/color) when it becomes active
    // so the strip can chip it even before the bridge mints its first tab.
    registerGroup: (group) => tabs.ensureGroup(group),
    // route the agent's cookie/browser opencli calls to Render's bridge profile.
    opencliProfile: bridgeProfile,
    // prefer a Render-managed CODEX_HOME (provider + creds from settings).
    materializeCodexHome: () => codexProvider.materializeCodexHome(),
    // Delta 3: persist each delivered Tier-2 page's spec so it can be saved/reopened.
    persistPage: (input) => pagesStore.persist(input),
    // a revised page persists as a new VERSION of the same entry, not a new draft.
    updatePage: (id, input) => {
      void pagesStore.addVersion(id, input);
    },
    now: () => Date.now(),
  });
  agentRef = agent;

  const broker = registerIpc({
    chrome: win.webContents,
    tabs,
    agent,
    humanHand,
    codex: codexProvider,
    pages: pagesStore,
  });

  // Degraded-mode visibility: these failures used to be console.warn-only, so
  // the user's first sign of trouble was a blank tab or a dead first prompt.
  // Emit one-line actionable notices into the feed instead (the broker buffers
  // them, so they survive renderer reloads and even a not-yet-loaded chrome).
  if (!resolveUxMjs()) {
    broker.emitAgent({
      kind: 'error',
      message:
        'generated pages disabled — opencli-ux kernel not found at ~/workspace/opencli-ux (set RENDER_PORTAL_UX_MJS)',
    });
  }
  if (bridgeEnabled) {
    void daemonReady.then((ok) => {
      if (!ok && !disposed) {
        broker.emitAgent({
          kind: 'error',
          message:
            'opencli engine unavailable — cookie/browser commands will fail. Install/launch OpenCLIApp (or run `opencli doctor`), then restart Render.',
        });
      }
    });
  }

  // Serve opencli's /ext browser backend from Render's OWN Chromium (default ON;
  // RENDER_OPENCLI_BRIDGE=0 disables). Cookie/browser adapters then run inside
  // Render as REAL tabs in the agent's owned tab group: `<site> login` opens a
  // visible tab the user logs into, and because every bridge tab shares the
  // `persist:render` session, that login authenticates the agent's commands.
  // Bridge tabs join the CURRENT conversation's group, read at mint time from the
  // agent runtime (new group ⟺ new conversation). The runtime is the conversation
  // owner — it allocates groups and starts fresh codex threads in lockstep.
  // Wired after daemon warmup so a cold boot never registers
  // `defaultContextId=render` while nothing listens on the daemon port.
  let opencliBridge: OpencliBridgeWire | null = null;
  if (bridgeEnabled) {
    void daemonReady
      .then(() => {
        if (disposed) return;
        opencliBridge = maybeWireOpencliBridge({ tabs, activeGroup: () => agent.activeGroup() });
      })
      .catch(() => {});
  }

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

  // Browser-correct keyboard semantics: Cmd+W closes the active TAB (full
  // teardown), not the whole window. New tab opens the home portal.
  installAppMenu({
    closeActiveTab: () => {
      const id = tabs.activeTabId;
      if (id) tabs.close(id);
    },
    newTab: () => {
      tabs.create();
    },
  });

  // keep page views inset correctly as the window resizes
  win.on('resize', () => tabs.relayout());

  // open the first (blank) browsing tab once the chrome is ready
  win.webContents.once('did-finish-load', () => {
    // Open the first tab on the opencli portal once daemon warmup + the portal
    // server settle (a second or two on a warm machine — the ux child's ready
    // deadline bounds the worst case). If the portal is disabled or never
    // starts, portalReady resolves null and the tab opens blank.
    if (tabs.activeTabId === null) {
      void portalReady.then(() => {
        if (!disposed && tabs.activeTabId === null) tabs.create();
      });
    }
    // CDP self-test is a dev diagnostic (opens example.com) — off by default.
    if (process.env.RENDER_DEBUG_CDP) void runCdpSelfTest(humanHand, tabs);
  });

  win.on('closed', () => {
    disposed = true;
    broker.dispose();
    void agent.dispose();
    void router.dispose();
    tabs.dispose();
    void humanHand.dispose();
    void opencliBridge?.dispose();
    void codexProvider.dispose();
    homePortal?.dispose();
    disposeUxHost(); // kill the pooled ux server (per-page servers die with their UxPages)
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

  // OpenCLIApp starts its node daemon lazily on first CLI use. Warm it in the
  // BACKGROUND — the window must never wait on it (a missing daemon used to hold
  // the first window for the full 15s poll). Daemon-dependent wiring (the /ext
  // bridge + home portal) awaits this promise inside wire(); the window, tabs,
  // and agent come up immediately.
  const daemonReady =
    process.env.RENDER_OPENCLI_BRIDGE !== '0' ? ensureOpencliDaemon() : Promise.resolve(true);

  const win = createWindow();
  wire(win, daemonReady);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createWindow();
      wire(next, daemonReady);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
