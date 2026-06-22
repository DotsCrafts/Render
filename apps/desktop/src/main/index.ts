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

// electron-vite emits this module as CommonJS, so `__dirname` is available.

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

  // Brain: codex app-server runs in a SECOND sandbox owned by the runtime.
  const agent = createAgentRuntime({
    emit: (event) => broker.emitAgent(event),
    sandbox: selectSandbox(),
    router,
    // give the BRAIN the human-hand relay so its own opencli browser-adapter
    // calls drive the user's real logged-in Chromium (not a headless sandbox).
    cdpEndpoint: () => humanHand.cdpEndpoint(),
    now: () => Date.now(),
  });

  const broker = registerIpc({ chrome: win.webContents, tabs, agent, humanHand });

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
    void tabs.create(url); // external link → new active browsing tab
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url !== 'about:blank') void tabs.create(url);
    return { action: 'deny' };
  });

  // keep page views inset correctly as the window resizes
  win.on('resize', () => tabs.relayout());

  // open the first real browsing tab once the chrome is ready
  win.webContents.once('did-finish-load', () => {
    if (tabs.activeTabId === null) tabs.create();
    void runCdpSelfTest(humanHand, tabs);
  });

  win.on('closed', () => {
    broker.dispose();
    void agent.dispose();
    void router.dispose();
    tabs.dispose();
    void humanHand.dispose();
  });
}

app.whenReady().then(() => {
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
