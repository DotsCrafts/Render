/**
 * Structural types for the opencli `/ext` bridge.
 *
 * The bridge is a WebSocket *client* of the opencli daemon's `/ext` socket. The
 * daemon believes it is talking to the browser extension; in fact it is talking
 * to us, and we drive Render's OWN Chromium instead of system Chrome.
 *
 * As with `@render/cdp-human-hand`, we deliberately do NOT import `electron`
 * here. A bridge target is the narrow CDP surface we actually drive, expressed
 * structurally so the transport is swappable: the production impl is backed by
 * `webContents.debugger` on a `WebContentsView`; tests use a fake target.
 */

// ── CDP transport seam (swappable) ────────────────────────────────────────────

/**
 * A single CDP-attachable surface. The bridge maps opencli's one `page` lease to
 * exactly one of these in Milestone 1 (single-lease). `send`/`on` mirror the two
 * primitives every CDP transport offers; everything else (navigate, exec,
 * screenshot…) is built on top of them in the action handlers.
 */
export interface CdpTarget {
  /** A stable identity used as opencli's `page` (CDP targetId) for this surface. */
  readonly targetId: string;
  /** Whether the underlying surface is still alive (tab/view not closed). */
  isAlive(): boolean;
  /** Attach the CDP session if not already attached (idempotent). */
  attach(): Promise<void>;
  /** Detach + tear down the underlying surface (the opencli `close-window`). */
  close(): Promise<void>;
  /** Send a raw CDP command and resolve with its result. */
  send<T = unknown>(method: string, params?: object): Promise<T>;
  /** Subscribe to a CDP event (e.g. `Page.loadEventFired`); returns an unsubscribe. */
  on(event: string, cb: (params: unknown) => void): () => void;
}

/**
 * Provides + owns the CDP targets the bridge leases. In production this is backed
 * by Render's `TabManager` (one `WebContentsView` per lease). In Milestone 1 the
 * bridge holds a single lease, so `acquire` returns the one leased target and
 * reuses it across navigations.
 */
export interface TargetProvider {
  /**
   * Return the target for opencli's `page` field. If `page` is given and still
   * alive, return that exact target (the lease is being reused). Otherwise mint /
   * return a fresh leased target. Throws `StalePageError` if `page` is supplied
   * but no longer alive (mirrors the extension's stale-page behaviour).
   */
  acquire(page?: string): Promise<CdpTarget>;
  /** The currently-leased target, if any (for diagnostics / close-window). */
  current(): CdpTarget | null;
  /** Tear down every target this provider owns. */
  dispose(): Promise<void>;
}

// ── Wire protocol (decoded from the opencli extension `background.js`) ─────────

/** First frame we send: registers us as the daemon's active browser profile. */
export interface HelloFrame {
  type: 'hello';
  /** The opencli contextId we impersonate (defaultContextId in browser-profiles.json). */
  contextId: string;
  version: string;
  compatRange: string;
}

/** A command the daemon forwards to us (one per `/command` HTTP body the CLI sends). */
export interface CommandFrame {
  id: string;
  action: string;
  session?: string;
  surface?: 'browser' | 'adapter' | (string & {});
  /** opencli's tab lease handle == a CDP targetId; omitted on the first navigate. */
  page?: string;
  /** Per-session idle-timeout override, in SECONDS (extension: sessionTimeoutOverrides). */
  idleTimeout?: number;
  /** Adapter-surface lifecycle override (extension: sessionLifecycleOverrides). */
  siteSession?: 'persistent' | 'ephemeral' | (string & {});
  // action-specific fields (loosely typed — the daemon adds/removes these freely)
  url?: string;
  code?: string;
  cdpMethod?: string;
  cdpParams?: object;
  domain?: string;
  format?: string;
  quality?: number;
  op?: string;
  [extra: string]: unknown;
}

/** Our reply, correlated back to the command by `id`. */
export type ResultFrame =
  | { id: string; ok: true; data: unknown; page?: string }
  | { id: string; ok: false; error: string; errorCode?: string; errorHint?: string; page?: string };

/** A captured wire frame, for the harness evidence log. */
export interface FrameRecord {
  ts: string;
  dir: 'TX' | 'RX';
  frame: HelloFrame | CommandFrame | ResultFrame;
}

// ── Errors ─────────────────────────────────────────────────────────────────────

/** Thrown when opencli references a `page` lease that is no longer alive. */
export class StalePageError extends Error {
  readonly errorCode = 'stale_page';
  constructor(page: string) {
    super(`Page not found: ${page} — stale page identity`);
    this.name = 'StalePageError';
  }
}
