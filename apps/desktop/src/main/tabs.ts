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
import type { TabState } from '@render/protocol';
import { contentBounds, type Bounds } from './layout.js';

export const HOME_URL = 'https://example.com';

interface Tab {
  id: string;
  view: WebContentsView;
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
  private order: string[] = [];
  private activeId: string | null = null;
  private panelOpen = true;
  private seq = 0;

  constructor(deps: TabManagerDeps) {
    this.window = deps.window;
    this.onChange = deps.onChange;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  create(url = HOME_URL, opts: { activate?: boolean } = {}): string {
    const id = `tab-${++this.seq}`;
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    const tab: Tab = { id, view };

    this.wireEvents(tab);
    this.window.contentView.addChildView(view);
    view.setBounds(this.bounds());
    view.setVisible(false);
    void view.webContents.loadURL(url);

    this.tabs.set(id, tab);
    this.order = [...this.order, id];
    if (opts.activate ?? true) this.activate(id);
    else this.emit();
    return id;
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

  /** The live webContents for a tab — consumed by the CDP human-hand. */
  getTarget(id: string): WebContents | undefined {
    return this.tabs.get(id)?.view.webContents;
  }

  listTabs(): Array<{ tabId: string; url: string; title: string }> {
    return this.order.map((id) => {
      const wc = this.tabs.get(id)!.view.webContents;
      return { tabId: id, url: wc.getURL(), title: wc.getTitle() };
    });
  }

  get activeTabId(): string | null {
    return this.activeId;
  }

  snapshot(): TabState[] {
    return this.order.map((id) => this.stateOf(this.tabs.get(id)!));
  }

  dispose(): void {
    for (const tab of this.tabs.values()) {
      this.window.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    this.tabs.clear();
    this.order = [];
    this.activeId = null;
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private bounds(): Bounds {
    const [w, h] = this.window.getContentSize();
    return contentBounds(w, h, this.panelOpen);
  }

  private stateOf(tab: Tab): TabState {
    const wc = tab.view.webContents;
    return {
      id: tab.id,
      title: wc.getTitle() || 'New Tab',
      url: wc.getURL(),
      loading: wc.isLoading(),
      agentControlled: wc.debugger.isAttached(),
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
