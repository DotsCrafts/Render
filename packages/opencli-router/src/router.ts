/**
 * OpencliRouter — the APP HAND.
 *
 * Routes an opencli invocation to the right hand:
 *   public/API adapters → @render/sandbox (headless, credential-blind)
 *   browser/cookie      → the real logged-in Chromium over CDP: the injected
 *                         `browserEndpoint` (Render's own debugging port) when
 *                         available, else the cdp-human-hand relay
 *                         (OPENCLI_CDP_ENDPOINT, client-pull)
 *
 * Classification comes from real `opencli list -f json` metadata (cached only
 * once metadata actually loaded, so a cold-boot failure can't poison routing
 * for the session). A not-logged-in adapter resolves to `needsLogin` rather
 * than crashing — on BOTH routes, since a misclassified cookie adapter can
 * fail with AUTH_REQUIRED in the sandbox too.
 *
 * Every exec is deadline-bounded (route-aware; the sandbox kills the child and
 * resolves a synthetic exit 124), EXCEPT `login`, which legitimately waits on
 * a human completing a login journey.
 */

import type {
  AdapterStrategy,
  OpencliInvocation,
  OpencliResult,
  OpencliRouter,
  SandboxSpawnOptions,
} from '@render/protocol';
import { buildArgv, type OpencliFormat } from './argv.js';
import { MetadataIndex, mapStrategy, type SiteMeta } from './metadata.js';
import {
  extractJson,
  extractLoginUrl,
  isAuthRequired,
  isBrowserUnavailable,
  parseWhoami,
  type WhoamiProbe,
} from './parse.js';
import type { CommandMeta, OpencliExec, OpencliRouterDeps } from './types.js';

export interface OpencliRouterHandle extends OpencliRouter {
  /** number of classified commands loaded from opencli metadata */
  catalogSize(): number;
  /** the OPENCLI_CDP_ENDPOINT the browser route would use (or null) */
  browserEndpoint(): Promise<string | null>;
  /** per-site aggregates from opencli metadata — the connectors catalog */
  listSites(): Promise<SiteMeta[]>;
  /**
   * Drop the cached catalog + classifications and re-read `opencli list` —
   * called after an adapter install so new/changed commands route correctly
   * without an app restart.
   */
  reloadMetadata(): Promise<void>;
  /** probe the site's login state via `whoami --site-session persistent` */
  whoami(site: string): Promise<WhoamiProbe>;
  /**
   * NO-NAVIGATION login-state sweep — `opencli auth status` runs every auth
   * adapter's quickCheck (cookie presence, zero tabs, zero page loads). This is
   * opencli's own login-state surface (OpenCLIApp uses the same) and the
   * AUTHORITATIVE badge signal. Pass `sites` to scope to `--site a,b`; pass
   * `full: true` to additionally run the per-site whoami (navigates — account
   * enrichment only, serialized so it can't stampede the browser bridge).
   */
  authStatus(sites?: string[], opts?: { full?: boolean }): Promise<AuthStatusRow[]>;
  /** best-effort `opencli <site> logout`; supported:false when the adapter has none */
  logout(site: string): Promise<{ supported: boolean }>;
  dispose(): Promise<void>;
}

/** One row of `opencli auth status -f json`. */
export interface AuthStatusRow {
  site: string;
  status: 'logged-in' | 'not-logged-in' | 'unknown' | 'error';
  /** identity label when logged in (adapter-defined, e.g. user_name) */
  identity?: string;
  /** which probe ran: 'quick' (cookie presence) or 'full' (whoami) */
  checked?: string;
  error?: string;
}

const DEFAULT_FALLBACK: Record<string, AdapterStrategy> = {
  arxiv: 'public',
  bbc: 'public',
  hackernews: 'public',
  npm: 'public',
  zhihu: 'cookie',
  dianping: 'cookie',
  '12306': 'cookie',
};

// Route-aware exec deadlines. Public/API adapters are pure network fetches;
// browser-route commands drive a real page (login-walled sites are slow), so
// they get more headroom. The internal `opencli list` metadata load is small
// and must never wedge the first classification.
const PUBLIC_TIMEOUT_MS = 60_000;
const BROWSER_TIMEOUT_MS = 120_000;
const METADATA_TIMEOUT_MS = 30_000;
const WHOAMI_TIMEOUT_MS = 45_000;
const LOGOUT_TIMEOUT_MS = 30_000;
const AUTH_STATUS_TIMEOUT_MS = 120_000;
// keep the bulk sweep snappy even when the bridge is down: per-site quick
// checks time out at 5s and run 12 wide (~40s worst case for ~90 auth sites)
const AUTH_STATUS_ARGS = ['--timeout', '5', '--concurrency', '12'] as const;

/**
 * MANDATORY on every login-site command (login/whoami/logout/…): the login
 * cookie lands in the PERSISTENT site session; without the flag the command
 * runs ephemeral and falsely reports "not logged in" (see agent-instructions).
 */
const SITE_SESSION_ARGS = ['--site-session', 'persistent'] as const;

export function createOpencliRouter(deps: OpencliRouterDeps): OpencliRouterHandle {
  const opencli = deps.opencliBin ?? 'opencli';
  const fallback = { ...DEFAULT_FALLBACK, ...(deps.fallback ?? {}) };
  const meta = new MetadataIndex();
  const classifyCache = new Map<string, AdapterStrategy>();
  let started = false;

  // Browser-driving login probes (deep whoami, `auth status --full`) must NEVER
  // run concurrently: N parallel page-navigations saturate the single browser
  // bridge and every command times out client-side at ~30s (field-caught when
  // the connectors panel fired connect() for 5 sites at once). Serialize them
  // through one promise chain — quick cookie sweeps stay off this lane.
  let browserLane: Promise<unknown> = Promise.resolve();
  const serializeBrowser = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = browserLane.then(fn, fn);
    // keep the chain alive but swallow this link's result/error for the tail
    browserLane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const ensureStarted = async (): Promise<void> => {
    if (started) return;
    try {
      deps.sandbox.workdir();
    } catch {
      await deps.sandbox.start();
    }
    started = true;
  };

  const run = async (argv: string[], opts: SandboxSpawnOptions = {}): Promise<OpencliExec> => {
    await ensureStarted();
    return deps.sandbox.exec(opencli, argv, opts);
  };

  const ensureMeta = async (): Promise<void> => {
    if (meta.loaded) return;
    await meta.load(() => run(['list', '-f', 'json'], { timeoutMs: METADATA_TIMEOUT_MS }));
  };

  const classify = async (site: string, command: string): Promise<AdapterStrategy> => {
    const cacheKey = `${site}/${command}`;
    const cached = classifyCache.get(cacheKey);
    if (cached) return cached;

    let strategy: AdapterStrategy;
    try {
      await ensureMeta();
      const m = meta.get(site, command);
      strategy = m ? mapStrategy(m) : (fallback[site] ?? 'public');
    } catch {
      // metadata unavailable → lean on the allowlist, default public (sandbox)
      strategy = fallback[site] ?? 'public';
    }
    // Cache only metadata-backed classifications. A fallback answer derived
    // from a failed `opencli list` (daemon cold boot, transient wedge) must be
    // recomputed on the next invoke, or the site stays misrouted all session.
    if (meta.loaded) classifyCache.set(cacheKey, strategy);
    return strategy;
  };

  const browserEndpoint = async (): Promise<string | null> => {
    if (deps.browserEndpoint) {
      try {
        return toHttpEndpoint(await deps.browserEndpoint());
      } catch {
        /* preferred endpoint unavailable → fall back to the human-hand relay */
      }
    }
    if (!deps.humanHand) return null;
    return toHttpEndpoint(await deps.humanHand.cdpEndpoint());
  };

  const invoke = async (inv: OpencliInvocation): Promise<OpencliResult> => {
    const format: OpencliFormat = inv.format ?? 'json';
    const strategy = await classify(inv.site, inv.command);
    const m = meta.get(inv.site, inv.command);
    const argv = buildArgv(inv, m, format);

    return strategy === 'public'
      ? invokePublic(inv, strategy, format, argv)
      : invokeBrowser(inv, strategy, format, argv, m);
  };

  /** needsLogin failure shape shared by both routes. */
  const loginFailure = (
    inv: OpencliInvocation,
    strategy: AdapterStrategy,
    ranOn: OpencliResult['ranOn'],
    authRequired: boolean,
    exec?: OpencliExec,
    domain?: string,
  ): OpencliResult => ({
    ok: false,
    strategy,
    ranOn,
    ...(exec?.stdout ? { raw: exec.stdout } : {}),
    error: authRequired
      ? 'login required'
      : 'browser session not connected — open the site in a Render tab to connect and log in',
    needsLogin: {
      site: inv.site,
      loginUrl:
        (exec && extractLoginUrl(exec, domain)) ?? (domain ? `https://${domain}` : undefined),
    },
  });

  const invokePublic = async (
    inv: OpencliInvocation,
    strategy: AdapterStrategy,
    format: OpencliFormat,
    argv: string[],
  ): Promise<OpencliResult> => {
    const exec = await run(argv, { timeoutMs: PUBLIC_TIMEOUT_MS });
    // A cookie adapter misrouted here (metadata gap / fallback default) fails
    // with AUTH_REQUIRED or BROWSER_CONNECT — map it to the same needsLogin
    // recovery card the browser route produces instead of a raw stderr dump.
    const authRequired = isAuthRequired(exec);
    if (authRequired || isBrowserUnavailable(exec)) {
      return loginFailure(inv, strategy, 'sandbox', authRequired, exec, meta.domainFor(inv.site));
    }
    return toResult(exec, strategy, 'sandbox', format);
  };

  const invokeBrowser = async (
    inv: OpencliInvocation,
    strategy: AdapterStrategy,
    format: OpencliFormat,
    argv: string[],
    m: CommandMeta | undefined,
  ): Promise<OpencliResult> => {
    const endpoint = await browserEndpoint();
    const domain = m?.domain ?? meta.domainFor(inv.site);

    if (!endpoint) {
      // No CDP route wired → we cannot reach the logged-in browser at all.
      return {
        ok: false,
        strategy,
        ranOn: 'cdp-human-hand',
        error: 'no CDP endpoint configured (human-hand unavailable)',
        needsLogin: { site: inv.site, loginUrl: domain ? `https://${domain}` : undefined },
      };
    }

    const exec = await run(argv, {
      env: { OPENCLI_CDP_ENDPOINT: endpoint },
      timeoutMs: BROWSER_TIMEOUT_MS,
    });
    const authRequired = isAuthRequired(exec);
    if (authRequired || isBrowserUnavailable(exec)) {
      return loginFailure(inv, strategy, 'cdp-human-hand', authRequired, exec, domain);
    }
    return toResult(exec, strategy, 'cdp-human-hand', format);
  };

  const login = async (
    site: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ loggedIn: boolean; account?: string }> => {
    const endpoint = await browserEndpoint();
    if (!endpoint) {
      throw new Error('login: no CDP endpoint (human-hand required to drive the login tab)');
    }
    // `opencli <site> login` opens the site in the real tab (via the relay) and
    // waits for the human to authenticate — UNBOUNDED by default: a deadline
    // would kill the login tab under the user mid-typing. Callers running the
    // journey in the BACKGROUND (the connectors service) pass timeoutMs so an
    // abandoned login can't leak a CLI process forever; expiry resolves
    // loggedIn:false and the caller re-verifies by whoami. The persistent site
    // session is where the cookie must land, or every later command runs
    // ephemeral and reports AUTH_REQUIRED despite the fresh login.
    const exec = await run([site, 'login', ...SITE_SESSION_ARGS, '-f', 'json'], {
      env: { OPENCLI_CDP_ENDPOINT: endpoint },
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const parsed = extractJson(exec.stdout);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const record = (row ?? {}) as Record<string, unknown>;
    const loggedIn =
      exec.exitCode === 0 && (record.logged_in === true || record.status === 'logged_in');
    const account = typeof record.user_name === 'string' ? record.user_name : undefined;
    return { loggedIn, account };
  };

  /** env for login-state probes: point cookie/browser adapters at Render's CDP. */
  const probeEnv = async (): Promise<Record<string, string> | undefined> => {
    const endpoint = await browserEndpoint();
    return endpoint ? { OPENCLI_CDP_ENDPOINT: endpoint } : undefined;
  };

  const listSites = async (): Promise<SiteMeta[]> => {
    await ensureMeta();
    return meta.sites();
  };

  const reloadMetadata = async (): Promise<void> => {
    meta.reset();
    classifyCache.clear();
    await ensureMeta(); // throws on failure — callers keep their stale view
  };

  const whoami = async (site: string): Promise<WhoamiProbe> => {
    try {
      await ensureMeta();
    } catch {
      /* metadata unavailable — probe blindly; parseWhoami degrades to 'unknown' */
    }
    if (meta.loaded && !meta.get(site, 'whoami')) {
      return { kind: 'unknown', detail: 'adapter has no whoami probe — connect to verify' };
    }
    // deep whoami navigates a page → serialize against other browser probes.
    return serializeBrowser(async () => {
      const env = await probeEnv();
      const exec = await run([site, 'whoami', ...SITE_SESSION_ARGS, '-f', 'json'], {
        ...(env ? { env } : {}),
        timeoutMs: WHOAMI_TIMEOUT_MS,
      });
      return parseWhoami(exec);
    });
  };

  const authStatus = async (
    sites?: string[],
    opts: { full?: boolean } = {},
  ): Promise<AuthStatusRow[]> => {
    const siteArgs = sites && sites.length ? ['--site', sites.join(',')] : [];
    const fullArgs = opts.full ? ['--full'] : [];
    const runSweep = async (): Promise<AuthStatusRow[]> => {
      const env = await probeEnv();
      const exec = await run(
        ['auth', 'status', ...siteArgs, ...fullArgs, ...AUTH_STATUS_ARGS, '-f', 'json'],
        { ...(env ? { env } : {}), timeoutMs: AUTH_STATUS_TIMEOUT_MS },
      );
      const parsed = extractJson(exec.stdout);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((row): row is Record<string, unknown> => row != null && typeof row === 'object')
        .map(toAuthStatusRow)
        .filter((row): row is AuthStatusRow => row !== undefined);
    };
    // `--full` navigates (whoami per site) → serialize; the quick sweep does not.
    return opts.full ? serializeBrowser(runSweep) : runSweep();
  };

  const logout = async (site: string): Promise<{ supported: boolean }> => {
    try {
      await ensureMeta();
    } catch {
      /* metadata unavailable — attempt anyway; a CLI rejection is harmless */
    }
    if (meta.loaded && !meta.get(site, 'logout')) return { supported: false };
    const env = await probeEnv();
    await run([site, 'logout', ...SITE_SESSION_ARGS, '-f', 'json'], {
      ...(env ? { env } : {}),
      timeoutMs: LOGOUT_TIMEOUT_MS,
    });
    return { supported: true };
  };

  const dispose = async (): Promise<void> => {
    if (started) await deps.sandbox.dispose();
    started = false;
  };

  return {
    classify,
    invoke,
    login,
    listSites,
    reloadMetadata,
    whoami,
    authStatus,
    logout,
    catalogSize: () => meta.size,
    browserEndpoint,
    dispose,
  };
}

const AUTH_STATUSES = new Set(['logged-in', 'not-logged-in', 'unknown', 'error']);

function toAuthStatusRow(raw: Record<string, unknown>): AuthStatusRow | undefined {
  if (typeof raw.site !== 'string' || !raw.site) return undefined;
  // live 1.8.5 emits snake_case row statuses (logged_in / not_logged_in) while
  // the --only flag documents kebab-case — normalize so both parse.
  const normalized = typeof raw.status === 'string' ? raw.status.replace(/_/g, '-') : '';
  const status = AUTH_STATUSES.has(normalized) ? (normalized as AuthStatusRow['status']) : 'unknown';
  const identity = typeof raw.identity === 'string' && raw.identity.trim() ? raw.identity.trim() : undefined;
  return {
    site: raw.site,
    status,
    ...(identity ? { identity } : {}),
    ...(typeof raw.checked === 'string' ? { checked: raw.checked } : {}),
    ...(typeof raw.error === 'string' && raw.error ? { error: raw.error } : {}),
  };
}

function toResult(
  exec: OpencliExec,
  strategy: AdapterStrategy,
  ranOn: OpencliResult['ranOn'],
  format: OpencliFormat,
): OpencliResult {
  const ok = exec.exitCode === 0;
  if (!ok) {
    return {
      ok: false,
      strategy,
      ranOn,
      raw: exec.stdout,
      error: (exec.stderr || exec.stdout || `opencli exited ${exec.exitCode}`).trim().slice(0, 500),
    };
  }
  if (format === 'json') {
    const data = extractJson(exec.stdout);
    if (data !== undefined) return { ok: true, strategy, ranOn, data, raw: exec.stdout };
  }
  return { ok: true, strategy, ranOn, raw: exec.stdout };
}

/** opencli treats an http endpoint as a /json discovery root; the relay serves it. */
function toHttpEndpoint(wsOrHttp: string): string {
  if (wsOrHttp.startsWith('http')) return wsOrHttp;
  return wsOrHttp.replace(/^ws/, 'http').split('?')[0];
}
