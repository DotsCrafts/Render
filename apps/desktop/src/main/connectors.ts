/**
 * ConnectorService — opencli site adapters as CONNECTORS (the Manus-connector
 * mental model): one row per site, a live login state, Connect opens the site's
 * login inside Render, and a whoami watch flips the row to Connected the moment
 * the human finishes — no "did it work?" guessing.
 *
 * State machine per site:
 *
 *   unknown ──probe──▶ checking ──▶ connected | disconnected | unknown
 *   any     ─connect─▶ connecting ─watch(whoami loop)─▶ connected
 *                                   └─ attempts exhausted ─▶ last stable + hint
 *
 * The truth source is `router.whoami` (exit 77 = signed out; a COMMAND_EXEC
 * failure past the auth gate = session live with verify drift; engine failures
 * = unknown — see @render/opencli-router parseWhoami). Stable states persist
 * via connectors-store so the page paints instantly next boot; transient states
 * (checking/connecting) never persist. Every transition emits a fresh immutable
 * snapshot to the renderer.
 */

import type { ConnectorInfo, ConnectorStatus } from '@render/protocol';
import type { SiteMeta, WhoamiProbe } from '@render/opencli-router';
import type { ConnectorsStore, StoredConnector } from './connectors-store.js';

/** The slice of the opencli router the service drives (test seam). */
export interface ConnectorRouterSlice {
  listSites(): Promise<SiteMeta[]>;
  whoami(site: string): Promise<WhoamiProbe>;
  logout(site: string): Promise<{ supported: boolean }>;
}

export interface ConnectorServiceDeps {
  router: ConnectorRouterSlice;
  store: ConnectorsStore;
  /** push a fresh ConnectorInfo[] snapshot to the renderer on every transition */
  emit: (connectors: ConnectorInfo[]) => void;
  /** open the site's login page in a real Render tab (tabs.openUrl) */
  openTab?: (url: string) => string | void;
  /** a watched login landed — let the conversation resume (agent.notifyLogin) */
  onConnected?: (site: string, account?: string) => void;
  now: () => number;
  /** injectable pause between watch probes (tests pass an instant resolver) */
  sleep?: (ms: number) => Promise<void>;
}

export interface ConnectorService {
  /** Current snapshot (cached statuses — never spawns a probe). */
  list(): Promise<ConnectorInfo[]>;
  /** Probe one site, or every stale login site when omitted (bounded, throttled). */
  refresh(site?: string): Promise<ConnectorInfo[]>;
  /** Open the site's login in a Render tab and watch whoami until it flips. */
  connect(site: string): Promise<ConnectorInfo[]>;
  /** Best-effort `opencli <site> logout`, then re-probe the real state. */
  disconnect(site: string): Promise<ConnectorInfo[]>;
  /** A login tab was opened outside the Connectors page — watch it the same way. */
  noteLoginOpened(site: string, loginUrl?: string): void;
  dispose(): void;
}

/** Runtime state per site (superset of StoredConnector's stable statuses). */
interface SiteState {
  status: ConnectorStatus;
  account?: string;
  lastChecked?: number;
  detail?: string;
}

const STALE_MS = 5 * 60_000;
const MAX_AUTO_PROBES = 8;
const PROBE_CONCURRENCY = 2;
const WATCH_INTERVAL_MS = 12_000;
const WATCH_ATTEMPTS = 20; // ≈4 minutes of login journey headroom

/**
 * Site aliases are lowercase slugs (zhihu, 12306, goat-faucet). The IPC surface
 * is renderer-reachable, so reject anything that could smuggle a flag or a path
 * into the opencli argv (`--profile`, `../x`) before it reaches the router.
 */
const SITE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

const assertSite = (site: string): void => {
  if (!SITE_RE.test(site)) throw new Error(`invalid connector site: ${JSON.stringify(site)}`);
};

const STATUS_RANK: Record<ConnectorStatus, number> = {
  connected: 0,
  connecting: 1,
  checking: 2,
  disconnected: 3,
  unknown: 4,
  none: 5,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createConnectorService(deps: ConnectorServiceDeps): ConnectorService {
  const sleep = deps.sleep ?? defaultSleep;
  const states = new Map<string, SiteState>();
  // last STABLE record per site — what connectors.json holds (transients excluded)
  let stored: Record<string, StoredConnector> = deps.store.load();
  let catalog: SiteMeta[] | null = null;
  // site → watch generation; a bumped/removed generation cancels the loop
  const watches = new Map<string, number>();
  const probing = new Set<string>();
  let disposed = false;

  for (const [site, rec] of Object.entries(stored)) {
    states.set(site, { ...rec });
  }

  const ensureCatalog = async (): Promise<void> => {
    if (catalog) return;
    try {
      catalog = await deps.router.listSites();
    } catch {
      // degraded (daemon cold / opencli missing): stored sites still render,
      // the next list() retries, and per-site probes surface the real error.
    }
  };

  const metaFor = (site: string): SiteMeta | undefined => catalog?.find((s) => s.site === site);

  const toInfo = (site: string): ConnectorInfo => {
    const meta = metaFor(site);
    const auth = meta ? (meta.authCommands > 0 ? 'login' : 'none') : 'login';
    const state = states.get(site);
    const status = state?.status ?? (auth === 'none' ? 'none' : 'unknown');
    return {
      site,
      name: site,
      ...(meta?.domain ? { domain: meta.domain } : {}),
      auth,
      status,
      ...(state?.account ? { account: state.account } : {}),
      commands: meta?.commands ?? 0,
      authCommands: meta?.authCommands ?? 0,
      ...(state?.lastChecked ? { lastChecked: state.lastChecked } : {}),
      ...(state?.detail ? { detail: state.detail } : {}),
    };
  };

  const snapshot = (): ConnectorInfo[] => {
    const sites = new Set<string>([
      ...(catalog ?? []).map((s) => s.site),
      ...states.keys(),
      ...Object.keys(stored),
    ]);
    return [...sites]
      .map(toInfo)
      // pseudo-adapters (ux/render/web…) have no domain and nothing to log into
      .filter((c) => c.auth === 'login' || c.domain !== undefined)
      .sort((a, b) => {
        if (a.auth !== b.auth) return a.auth === 'login' ? -1 : 1;
        const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        return rank !== 0 ? rank : a.site.localeCompare(b.site);
      });
  };

  const emit = (): void => deps.emit(snapshot());

  /** Transition a site; stable statuses also persist to connectors.json. */
  const apply = (site: string, next: SiteState): void => {
    states.set(site, next);
    if (next.status === 'connected' || next.status === 'disconnected' || next.status === 'unknown') {
      stored = {
        ...stored,
        [site]: {
          status: next.status,
          ...(next.account ? { account: next.account } : {}),
          ...(next.lastChecked ? { lastChecked: next.lastChecked } : {}),
          ...(next.detail ? { detail: next.detail } : {}),
        },
      };
      deps.store.save(stored);
    }
    emit();
  };

  const applyProbe = (site: string, probe: WhoamiProbe): void => {
    const prev = states.get(site);
    if (probe.kind === 'connected') {
      apply(site, {
        status: 'connected',
        // a verify-drift probe carries no account — keep the last known label
        ...(probe.account ?? prev?.account ? { account: probe.account ?? prev?.account } : {}),
        ...(probe.detail ? { detail: probe.detail } : {}),
        lastChecked: deps.now(),
      });
      return;
    }
    if (probe.kind === 'disconnected') {
      apply(site, { status: 'disconnected', lastChecked: deps.now() });
      return;
    }
    apply(site, { status: 'unknown', detail: probe.detail, lastChecked: deps.now() });
  };

  /**
   * One whoami probe with the transient 'checking' state; deduped per site.
   * A live login WATCH owns its site's badge: a probe that lands mid-journey
   * (a queued auto-refresh, or the human hitting Check) may confirm the login
   * early, but a not-yet verdict must NOT tear waiting-for-sign-in down to
   * "Not connected" while the watch is still polling — journey-caught race.
   */
  const probe = async (site: string): Promise<void> => {
    if (probing.has(site) || disposed) return;
    probing.add(site);
    const prev = states.get(site);
    const watchOwned = prev?.status === 'connecting' && watches.has(site);
    apply(site, { ...(prev ?? { status: 'unknown' }), status: 'checking' });
    try {
      const verdict = await deps.router.whoami(site);
      if (watchOwned && verdict.kind === 'connected') {
        // deleting the watch claims the single onConnected — if the watch's own
        // poll confirmed first (and deleted), this returns false: no double fire
        const claimed = watches.delete(site);
        applyProbe(site, verdict);
        if (claimed) deps.onConnected?.(site, verdict.account);
      } else if (watchOwned && watches.has(site)) {
        apply(site, prev as SiteState); // restore waiting-for-sign-in
      } else {
        applyProbe(site, verdict);
      }
    } catch (err) {
      if (watchOwned && watches.has(site)) {
        apply(site, prev as SiteState);
      } else {
        apply(site, {
          status: 'unknown',
          detail: err instanceof Error ? err.message : String(err),
          lastChecked: deps.now(),
        });
      }
    } finally {
      probing.delete(site);
    }
  };

  /**
   * Poll whoami until the human's login lands. Generation-scoped: a newer
   * connect() or dispose() strands this loop harmlessly.
   */
  const beginWatch = (site: string): void => {
    const gen = (watches.get(site) ?? 0) + 1;
    watches.set(site, gen);
    void (async () => {
      let lastStable: WhoamiProbe = { kind: 'unknown', detail: 'login not detected yet' };
      for (let attempt = 0; attempt < WATCH_ATTEMPTS; attempt++) {
        await sleep(WATCH_INTERVAL_MS);
        if (disposed || watches.get(site) !== gen) return;
        let result: WhoamiProbe;
        try {
          result = await deps.router.whoami(site);
        } catch {
          continue; // transient probe failure — keep watching
        }
        if (disposed || watches.get(site) !== gen) return;
        if (result.kind === 'connected') {
          watches.delete(site);
          applyProbe(site, result);
          deps.onConnected?.(site, result.account);
          return;
        }
        lastStable = result;
      }
      if (disposed || watches.get(site) !== gen) return;
      watches.delete(site);
      const detail =
        lastStable.kind === 'unknown' && lastStable.detail
          ? lastStable.detail
          : 'login not detected — finish signing in, then hit Check';
      apply(site, {
        status: lastStable.kind === 'disconnected' ? 'disconnected' : 'unknown',
        detail,
        lastChecked: deps.now(),
      });
    })();
  };

  const list = async (): Promise<ConnectorInfo[]> => {
    await ensureCatalog();
    return snapshot();
  };

  const refresh = async (site?: string): Promise<ConnectorInfo[]> => {
    await ensureCatalog();
    if (site) {
      assertSite(site);
      await probe(site);
      return snapshot();
    }
    const now = deps.now();
    const candidates = snapshot()
      .filter((c) => c.auth === 'login')
      .filter((c) => c.status !== 'connecting' && c.status !== 'checking')
      .filter((c) => !c.lastChecked || now - c.lastChecked > STALE_MS)
      .sort((a, b) => (a.lastChecked ?? 0) - (b.lastChecked ?? 0))
      .slice(0, MAX_AUTO_PROBES)
      .map((c) => c.site);
    const queue = [...candidates];
    await Promise.all(
      Array.from({ length: PROBE_CONCURRENCY }, async () => {
        for (let next = queue.shift(); next && !disposed; next = queue.shift()) {
          await probe(next);
        }
      }),
    );
    return snapshot();
  };

  const connect = async (site: string): Promise<ConnectorInfo[]> => {
    assertSite(site);
    await ensureCatalog();
    const domain = metaFor(site)?.domain;
    const prev = states.get(site);
    if (domain && deps.openTab) {
      deps.openTab(`https://${domain}`);
      apply(site, {
        ...(prev?.account ? { account: prev.account } : {}),
        status: 'connecting',
        detail: 'complete the sign-in in the opened tab — Render is watching for it',
      });
      beginWatch(site);
    } else {
      apply(site, {
        ...(prev ?? { status: 'unknown' }),
        detail: domain
          ? 'no browser tab available to open the login page'
          : 'no domain known for this adapter — open the site, sign in, then hit Check',
      });
    }
    return snapshot();
  };

  const disconnect = async (site: string): Promise<ConnectorInfo[]> => {
    assertSite(site);
    await ensureCatalog();
    watches.delete(site); // a manual disconnect cancels any pending login watch
    const prev = states.get(site);
    // restoring a TRANSIENT prev would strand a spinner with no watch behind it
    // (Connect → Disconnect while connecting) — coerce those to unknown.
    const prevStable: SiteState =
      prev && prev.status !== 'connecting' && prev.status !== 'checking'
        ? prev
        : { status: 'unknown', ...(prev?.account ? { account: prev.account } : {}) };
    apply(site, { ...prevStable, status: 'checking' });
    try {
      const res = await deps.router.logout(site);
      if (!res.supported) {
        apply(site, {
          ...prevStable,
          detail: 'adapter has no logout command — sign out on the site itself, then hit Check',
        });
        return snapshot();
      }
      applyProbe(site, await deps.router.whoami(site));
    } catch (err) {
      apply(site, {
        status: 'unknown',
        detail: err instanceof Error ? err.message : String(err),
        lastChecked: deps.now(),
      });
    }
    return snapshot();
  };

  const noteLoginOpened = (site: string): void => {
    if (disposed || !SITE_RE.test(site)) return; // best-effort hook — never throws
    const prev = states.get(site);
    apply(site, {
      ...(prev?.account ? { account: prev.account } : {}),
      status: 'connecting',
      detail: 'sign-in tab opened — Render is watching for the login',
    });
    beginWatch(site);
  };

  const dispose = (): void => {
    disposed = true;
    watches.clear();
  };

  return { list, refresh, connect, disconnect, noteLoginOpened, dispose };
}
