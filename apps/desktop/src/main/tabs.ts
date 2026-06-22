/**
 * TabManager — owns the tab → WebContentsView map and renders REAL web pages.
 *
 * Each tab is a `WebContentsView` (NOT a <webview>) added on top of the chrome
 * renderer and inset to the content rect. Only the active tab is visible. The
 * manager emits an immutable `TabState[]` snapshot on every change so the
 * renderer's tab strip / omnibox stay in sync, and exposes `getTarget` so the
 * CDP human-hand can attach to a tab's webContents.
 */

import { WebContentsView, type BaseWindow, type WebContents } from 'electron';
import type { TabState, TabGroupInfo } from '@render/protocol';
import { CHROME, clampPanelWidth, contentBounds, type Bounds } from './layout.js';

export const HOME_URL = 'about:blank';
const BLANK_URLS = new Set(['', 'about:blank', HOME_URL]);

/**
 * The persistent session partition shared by the user's tabs AND the opencli
 * bridge's off-screen views. Sharing it is what makes "log in inside Render"
 * actually work: a cookie you set by logging in on a visible tab is visible to
 * the agent's opencli when it drives a bridge view in the SAME session.
 */
export const RENDER_PARTITION = 'persist:render';

interface Tab {
  id: string;
  view: WebContentsView;
  /** group this tab belongs to, if any (e.g. the agent's owned tab group). */
  groupId?: string;
}

export interface TabManagerDeps {
  window: BaseWindow;
  /** called with a fresh immutable snapshot whenever tab state changes */
  onChange: (tabs: TabState[]) => void;
}

export class TabManager {
  private readonly window: BaseWindow;
  private readonly onChange: (tabs: TabState[]) => void;
  private readonly tabs = new Map<string, Tab>();
  /** group id → group metadata (label/color), surfaced in every snapshot. */
  private readonly groups = new Map<string, TabGroupInfo>();
  private order: string[] = [];
  private activeId: string | null = null;
  private panelOpen = true;
  private panelWidth: number = CHROME.panelWidth;
  private seq = 0;

  constructor(deps: TabManagerDeps) {
    this.window = deps.window;
    this.onChange = deps.onChange;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /** Register (or update) a tab group so tabs can reference it by id. */
  ensureGroup(info: TabGroupInfo): void {
    this.groups.set(info.id, info);
  }

  create(url = HOME_URL, opts: { activate?: boolean; groupId?: string } = {}): string {
    const id = `tab-${++this.seq}`;
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, partition: RENDER_PARTITION },
    });
    const tab: Tab = { id, view, ...(opts.groupId ? { groupId: opts.groupId } : {}) };

    // Register BEFORE loadURL: loadURL can synchronously emit did-start-loading
    // → onChange → snapshot, which must see a fully-registered tab.
    this.tabs.set(id, tab);
    this.order = [...this.order, id];
    this.wireEvents(tab);
    this.window.contentView.addChildView(view);
    view.setBounds(this.bounds());
    view.setVisible(false);
    void view.webContents.loadURL(url);

    if (opts.activate ?? true) this.activate(id);
    else this.emit();
    return id;
  }

  /**
   * Open a URL like a traditional browser: if the active tab is a blank
   * new-tab, navigate it in place (replace); otherwise open a fresh active tab.
   * Used by the chrome-shell nav guard (agent-panel links, window.open).
   */
  openUrl(url: string): string {
    const active = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (active && BLANK_URLS.has(active.view.webContents.getURL())) {
      void this.navigate(active.id, url);
      this.activate(active.id);
      return active.id;
    }
    return this.create(url);
  }

  close(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
    this.order = this.order.filter((t) => t !== id);

    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order[this.order.length - 1];
      if (next) this.activate(next);
      else this.create(); // never leave the user tab-less
    }
    this.emit();
  }

  activate(id: string): void {
    if (!this.tabs.has(id)) return;
    this.activeId = id;
    for (const [tabId, tab] of this.tabs) {
      const isActive = tabId === id;
      tab.view.setVisible(isActive);
      if (isActive) tab.view.setBounds(this.bounds());
    }
    this.emit();
  }

  async navigate(id: string, url: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    await tab.view.webContents.loadURL(normalizeUrl(url));
  }

  goBack(id: string): void {
    const nav = this.tabs.get(id)?.view.webContents.navigationHistory;
    if (nav?.canGoBack()) nav.goBack();
  }

  goForward(id: string): void {
    const nav = this.tabs.get(id)?.view.webContents.navigationHistory;
    if (nav?.canGoForward()) nav.goForward();
  }

  reload(id: string): void {
    this.tabs.get(id)?.view.webContents.reload();
  }

  /** Re-inset every view; call on window resize / panel toggle. */
  relayout(): void {
    const b = this.bounds();
    for (const tab of this.tabs.values()) tab.view.setBounds(b);
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.relayout();
  }

  /** Resize the agent panel — re-insets the page views to match (clamped). */
  setPanelWidth(width: number): void {
    this.panelWidth = clampPanelWidth(width);
    this.relayout();
  }

  /** The live webContents for a tab — consumed by the CDP human-hand. */
  getTarget(id: string): WebContents | undefined {
    return this.tabs.get(id)?.view.webContents;
  }

  listTabs(): Array<{ tabId: string; url: string; title: string }> {
    this.reapDead();
    return this.order.flatMap((id) => {
      const tab = this.tabs.get(id);
      if (!tab || !this.isLive(tab)) return [];
      const wc = tab.view.webContents;
      return [{ tabId: id, url: wc.getURL(), title: wc.getTitle() }];
    });
  }

  get activeTabId(): string | null {
    return this.activeId;
  }

  snapshot(): TabState[] {
    this.reapDead();
    return this.order.map((id) => this.stateOf(this.tabs.get(id)!));
  }

  dispose(): void {
    for (const tab of this.tabs.values()) {
      try {
        this.window.contentView.removeChildView(tab.view);
        if (this.isLive(tab)) tab.view.webContents.close();
      } catch {
        /* view already torn down */
      }
    }
    this.tabs.clear();
    this.order = [];
    this.activeId = null;
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private bounds(): Bounds {
    const [w, h] = this.window.getContentSize();
    return contentBounds(w, h, this.panelOpen, this.panelWidth);
  }

  /** A tab is live only while its webContents exists and isn't destroyed. */
  private isLive(tab: Tab): boolean {
    const wc = tab.view.webContents as WebContents | undefined;
    return !!wc && !wc.isDestroyed();
  }

  /**
   * Drop tabs whose webContents died out-of-band (renderer crash, external
   * close, a bridge lease torn down via CDP). Without this, snapshot() would
   * dereference a destroyed view and throw, breaking every tab op.
   */
  private reapDead(): void {
    const dead = [...this.tabs.values()].filter((tab) => !this.isLive(tab));
    if (dead.length === 0) return;
    for (const tab of dead) {
      this.tabs.delete(tab.id);
      this.order = this.order.filter((t) => t !== tab.id);
      if (this.activeId === tab.id) this.activeId = null;
    }
    if (this.activeId === null) {
      const next = this.order[this.order.length - 1];
      if (next) this.activeId = next; // re-point without re-emitting (we're inside snapshot)
    }
  }

  private stateOf(tab: Tab): TabState {
    const group = tab.groupId ? this.groups.get(tab.groupId) : undefined;
    const groupPart = group ? { group } : {};
    if (!this.isLive(tab)) {
      // Defensive: a tab racing toward teardown still gets a safe snapshot row.
      return { id: tab.id, title: 'New Tab', url: '', loading: false, agentControlled: false, ...groupPart };
    }
    const wc = tab.view.webContents;
    return {
      id: tab.id,
      title: wc.getTitle() || 'New Tab',
      url: wc.getURL(),
      loading: wc.isLoading(),
      agentControlled: wc.debugger.isAttached(),
      ...groupPart,
    };
  }

  private emit(): void {
    this.onChange(this.snapshot());
  }

  private wireEvents(tab: Tab): void {
    const wc = tab.view.webContents;
    const onChange = (): void => this.emit();
    wc.on('page-title-updated', onChange);
    wc.on('did-navigate', onChange);
    wc.on('did-navigate-in-page', onChange);
    wc.on('did-start-loading', onChange);
    wc.on('did-stop-loading', onChange);
    wc.on('page-favicon-updated', onChange);
    // webContents died (crash, external close, bridge lease teardown) — reap the
    // tab and re-emit so the strip drops it instead of snapshot throwing on it.
    wc.on('destroyed', () => {
      if (!this.tabs.has(tab.id)) return;
      this.emit(); // emit() → snapshot() → reapDead() removes the dead tab
      if (this.activeId === null && this.tabs.size === 0) this.create();
    });
    wc.on('render-process-gone', onChange);

    // Links that request a new window open as a new tab instead of a popup.
    wc.setWindowOpenHandler(({ url }) => {
      this.create(url);
      return { action: 'deny' };
    });
  }
}

const normalizeUrl = (raw: string): string => {
  const value = raw.trim();
  if (/^[a-z]+:\/\//i.test(value) || value.startsWith('about:')) return value;
  if (/^localhost(:\d+)?(\/|$)/.test(value) || /^\d{1,3}(\.\d{1,3}){3}/.test(value)) {
    return `http://${value}`;
  }
  // looks like a domain → https, otherwise treat as a search query
  if (/^[^\s/]+\.[^\s/]+/.test(value)) return `https://${value}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
};
