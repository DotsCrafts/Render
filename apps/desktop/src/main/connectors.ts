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
import type { AuthStatusRow, SiteMeta, WhoamiProbe } from '@render/opencli-router';
import type { ConnectorsStore, StoredConnector } from './connectors-store.js';

/** The slice of the opencli router the service drives (test seam). */
export interface ConnectorRouterSlice {
  listSites(): Promise<SiteMeta[]>;
  whoami(site: string): Promise<WhoamiProbe>;
  /** bulk NO-NAVIGATION quickCheck sweep (`opencli auth status`) — zero tabs */
  authStatus(): Promise<AuthStatusRow[]>;
  logout(site: string): Promise<{ supported: boolean }>;
  /** adapter-driven sign-in (`opencli <site> login`); bounded via timeoutMs */
  login(site: string, opts?: { timeoutMs?: number }): Promise<{ loggedIn: boolean; account?: string }>;
}

export interface ConnectorServiceDeps {
  router: ConnectorRouterSlice;
  store: ConnectorsStore;
  /** push a fresh ConnectorInfo[] snapshot to the renderer on every transition */
  emit: (connectors: ConnectorInfo[]) => void;
  /** open the site's login page in a real Render tab (tabs.openUrl) */
  openTab?: (url: string) => string | void;
  /**
   * A login journey actually started (a sign-in surface is opening). The host
   * narrates it in the agent feed — the Connectors panel closes on Connect so
   * the login tab is visible, and the feed carries the journey from there.
   */
  onConnecting?: (site: string) => void;
  /** a watched login landed — let the conversation resume (agent.notifyLogin) */
  onConnected?: (site: string, account?: string) => void;
  now: () => number;
  /** injectable pause between watch probes (tests pass an instant resolver) */
  sleep?: (ms: number) => Promise<void>;
}

export interface ConnectorService {
  /** Current snapshot (cached statuses — never spawns a probe). */
  list(): Promise<ConnectorInfo[]>;
  /**
   * With a site: one DEEP whoami probe (navigates — user-initiated Check).
   * Without: one bulk `auth status` quickCheck sweep — cookie presence only,
   * ZERO navigation, zero tabs (the Refresh button; never runs on open).
   */
  refresh(site?: string): Promise<ConnectorInfo[]>;
  /** Open the site's login in a Render tab and watch whoami until it flips. */
  connect(site: string): Promise<ConnectorInfo[]>;
  /** Best-effort `opencli <site> logout`, then re-probe the real state. */
  disconnect(site: string): Promise<ConnectorInfo[]>;
  dispose(): void;
}

/** Runtime state per site (superset of StoredConnector's stable statuses). */
interface SiteState {
  status: ConnectorStatus;
  account?: string;
  lastChecked?: number;
  detail?: string;
}

const WATCH_INTERVAL_MS = 12_000;
/**
 * WALL-CLOCK bound for the whoami watch. An attempt count alone stretched the
 * journey to ~16 minutes of "Waiting for sign-in" when each probe ran into its
 * own 45s deadline (unreachable sites) — the badge must resolve on human time.
 */
const WATCH_DEADLINE_MS = 4 * 60_000;
/**
 * Cap for a background `opencli <site> login` journey. Expiry kills the CLI
 * (loggedIn:false) and a decisive whoami settles the badge — an abandoned
 * Connect must not leak a waiting CLI process forever.
 */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

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
   * Poll whoami until the human's login lands, bounded by WALL CLOCK (slow or
   * unreachable probes must not stretch the journey). Generation-scoped: a
   * newer connect() or dispose() strands this loop harmlessly.
   */
  const beginWatch = (site: string): number => {
    const gen = (watches.get(site) ?? 0) + 1;
    watches.set(site, gen);
    const deadline = deps.now() + WATCH_DEADLINE_MS;
    void (async () => {
      let lastStable: WhoamiProbe = { kind: 'unknown', detail: 'login not detected yet' };
      while (deps.now() < deadline) {
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
    return gen;
  };

  const list = async (): Promise<ConnectorInfo[]> => {
    await ensureCatalog();
    return snapshot();
  };

  /** Map one `auth status` quickCheck row onto a connector transition. */
  const applyAuthRow = (row: AuthStatusRow): void => {
    const state = states.get(row.site);
    // a live login watch owns its badge; quick rows must not tear it down
    if (state?.status === 'connecting' || state?.status === 'checking') return;
    if (row.status === 'logged-in') {
      apply(row.site, {
        status: 'connected',
        ...(row.identity ?? state?.account ? { account: row.identity ?? state?.account } : {}),
        detail: 'quick check — session cookie present',
        lastChecked: deps.now(),
      });
      return;
    }
    if (row.status === 'not-logged-in') {
      apply(row.site, { status: 'disconnected', lastChecked: deps.now() });
      return;
    }
    apply(row.site, {
      status: 'unknown',
      detail: /quickCheck not implemented/i.test(row.error ?? '')
        ? 'no quick probe for this adapter — hit Check to verify'
        : (row.error ?? 'quick check inconclusive'),
      lastChecked: deps.now(),
    });
  };

  const refresh = async (site?: string): Promise<ConnectorInfo[]> => {
    await ensureCatalog();
    if (site) {
      assertSite(site);
      await probe(site);
      return snapshot();
    }
    // Bulk sweep: ONE `auth status` run, quickCheck (cookie presence) per auth
    // adapter — no page loads, no bridge lease tabs. Only sites this page
    // tracks are applied; adapters outside the catalog are ignored.
    const tracked = new Set(snapshot().map((c) => c.site));
    try {
      const rows = await deps.router.authStatus();
      for (const row of rows) {
        if (tracked.has(row.site)) applyAuthRow(row);
      }
    } catch {
      // sweep unavailable (engine down) — cached statuses stand; per-site
      // Check still works and reports the real error.
    }
    return snapshot();
  };

  /**
   * Adapter-driven sign-in: `opencli <site> login` opens the adapter's OWN
   * login page (e.g. 12306 → kyfw.12306.cn/otn/resources/login.html — the
   * naive https://<domain> hit an apex-cert error there) and resolves when the
   * human completes. The whoami watch runs alongside as the early-flip belt;
   * the CLI's own resolution settles anything the watch missed. Journey-scoped
   * by watch generation: a newer connect/disconnect strands this run.
   */
  const runAdapterLogin = (site: string, gen: number): void => {
    void deps.router
      .login(site, { timeoutMs: LOGIN_TIMEOUT_MS })
      .then(async (res) => {
        if (disposed || watches.get(site) !== gen) return; // superseded journey
        if (res.loggedIn) {
          watches.delete(site); // claim the single onConnected
          apply(site, {
            status: 'connected',
            ...(res.account ? { account: res.account } : {}),
            lastChecked: deps.now(),
          });
          deps.onConnected?.(site, res.account);
          return;
        }
        // login exited without a clean success (timeout, closed tab, or a
        // verify-drift exit) — whoami is the truth source, not login's exit
        // (agent-instructions contract). End the watch and probe decisively.
        watches.delete(site);
        await probe(site);
      })
      .catch(async (err) => {
        if (disposed || watches.get(site) !== gen) return;
        watches.delete(site);
        try {
          await probe(site);
        } catch {
          apply(site, {
            status: 'unknown',
            detail: err instanceof Error ? err.message : String(err),
            lastChecked: deps.now(),
          });
        }
      });
  };

  /**
   * Fallback login URL when the adapter has no `login` command. Bare apex
   * domains frequently don't carry a valid cert (https://12306.cn →
   * ERR_CERT_COMMON_NAME_INVALID) — prefix www. on two-label domains; deeper
   * hosts (mooc2-ans.chaoxing.com) are already specific.
   */
  const loginTabUrl = (domain: string): string =>
    domain.split('.').length === 2 ? `https://www.${domain}` : `https://${domain}`;

  const connect = async (site: string): Promise<ConnectorInfo[]> => {
    assertSite(site);
    await ensureCatalog();
    const meta = metaFor(site);
    const prev = states.get(site);
    if (meta?.hasLogin) {
      apply(site, {
        ...(prev?.account ? { account: prev.account } : {}),
        status: 'connecting',
        detail: 'sign-in page opening in a Render tab — Render detects completion automatically',
      });
      const gen = beginWatch(site);
      runAdapterLogin(site, gen);
      deps.onConnecting?.(site);
    } else if (meta?.domain && deps.openTab) {
      deps.openTab(loginTabUrl(meta.domain));
      apply(site, {
        ...(prev?.account ? { account: prev.account } : {}),
        status: 'connecting',
        detail: 'complete the sign-in in the opened tab — Render is watching for it',
      });
      beginWatch(site);
      deps.onConnecting?.(site);
    } else {
      apply(site, {
        ...(prev ?? { status: 'unknown' }),
        detail: meta?.domain
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

  const dispose = (): void => {
    disposed = true;
    watches.clear();
  };

  return { list, refresh, connect, disconnect, dispose };
}
