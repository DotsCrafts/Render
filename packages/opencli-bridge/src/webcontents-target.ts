/**
 * WebContentsView-backed `CdpTarget` — the production transport.
 *
 * Mirrors `@render/cdp-human-hand`: drive CDP through `webContents.debugger`
 * (CDP 1.3) on an Electron `WebContentsView`, never system Chrome. We keep the
 * Electron surface structural (no `electron` import) so this package stays
 * decoupled and unit-testable with a fake debugger — the main process injects
 * the real view.
 *
 * `targetId` is opencli's `page` lease handle. CDP's real `Target.targetId` is
 * only obtainable after a round-trip; for a single in-process view we instead
 * mint a STABLE id once and keep it across navigations (opencli only needs a
 * stable opaque handle, and stability across navigations is exactly the lease
 * contract the spike flagged as load-bearing).
 */

import { randomUUID } from 'node:crypto';
import type { CdpTarget } from './types.js';

const PROTOCOL_VERSION = '1.3';

/** The subset of Electron's `webContents.debugger` we drive (CDP 1.3). */
export interface WcDebugger {
  attach(protocolVersion?: string): void;
  isAttached(): boolean;
  detach(): void;
  sendCommand(method: string, commandParams?: object, sessionId?: string): Promise<unknown>;
  on(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void,
  ): void;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners(event?: string): void;
}

/** The subset of Electron's `WebContents` we touch. */
export interface WcContents {
  readonly debugger: WcDebugger;
  isDestroyed(): boolean;
  close(): void;
  /** Load a URL — used to bring the page process alive before CDP attaches. */
  loadURL(url: string): Promise<void>;
  getURL(): string;
}

export interface WebContentsTargetDeps {
  /** The live webContents of the WebContentsView this lease owns. */
  webContents: WcContents;
  /** Tear down the owning view (remove from window + close). The main process
   *  owns the view lifecycle, so closing the lease delegates back to it. */
  destroyView: () => void;
  /** Stable lease id; auto-generated if omitted. */
  targetId?: string;
}

export function createWebContentsTarget(deps: WebContentsTargetDeps): CdpTarget {
  const { webContents, destroyView } = deps;
  const targetId = deps.targetId ?? randomUUID().replace(/-/g, '').toUpperCase();
  const dbg = webContents.debugger;

  // Fan a single `debugger.message` event out to per-method subscribers, so
  // multiple callers (e.g. a navigate awaiting Page.loadEventFired) can listen
  // without clobbering each other's listeners.
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  let wired = false;

  const wire = (): void => {
    if (wired) return;
    dbg.on('message', (_event, method, params) => {
      const set = listeners.get(method);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(params);
        } catch {
          /* a listener throwing must not break CDP demux */
        }
      }
    });
    wired = true;
  };

  const attach = async (): Promise<void> => {
    // A never-loaded WebContentsView has no live page process, so CDP domain
    // commands (Page.enable) hang forever. Bring the page up with about:blank
    // first — proven in the harness: without this, Page.enable never resolves.
    if (!webContents.getURL()) await webContents.loadURL('about:blank');
    if (!dbg.isAttached()) dbg.attach(PROTOCOL_VERSION);
    wire();
    // The bridge's actions assume Page/Runtime events flow; enable them once.
    await dbg.sendCommand('Page.enable').catch(() => {});
    await dbg.sendCommand('Runtime.enable').catch(() => {});
  };

  const isAlive = (): boolean => !webContents.isDestroyed();

  const send = async <T = unknown>(method: string, params?: object): Promise<T> => {
    if (!isAlive()) throw new Error(`target ${targetId} is destroyed`);
    if (!dbg.isAttached()) await attach();
    return dbg.sendCommand(method, params ?? {}) as Promise<T>;
  };

  const on = (event: string, cb: (params: unknown) => void): (() => void) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  };

  const close = async (): Promise<void> => {
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      /* already detached */
    }
    listeners.clear();
    destroyView();
  };

  return { targetId, isAlive, attach, send, on, close };
}
