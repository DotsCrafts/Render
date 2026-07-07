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
import { MetadataIndex, mapStrategy } from './metadata.js';
import { extractJson, extractLoginUrl, isAuthRequired, isBrowserUnavailable } from './parse.js';
import type { CommandMeta, OpencliExec, OpencliRouterDeps } from './types.js';

export interface OpencliRouterHandle extends OpencliRouter {
  /** number of classified commands loaded from opencli metadata */
  catalogSize(): number;
  /** the OPENCLI_CDP_ENDPOINT the browser route would use (or null) */
  browserEndpoint(): Promise<string | null>;
  dispose(): Promise<void>;
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

export function createOpencliRouter(deps: OpencliRouterDeps): OpencliRouterHandle {
  const opencli = deps.opencliBin ?? 'opencli';
  const fallback = { ...DEFAULT_FALLBACK, ...(deps.fallback ?? {}) };
  const meta = new MetadataIndex();
  const classifyCache = new Map<string, AdapterStrategy>();
  let started = false;

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

  const login = async (site: string): Promise<{ loggedIn: boolean; account?: string }> => {
    const endpoint = await browserEndpoint();
    if (!endpoint) {
      throw new Error('login: no CDP endpoint (human-hand required to drive the login tab)');
    }
    // `opencli <site> login` opens the site in the real tab (via the relay) and
    // waits for the human to authenticate — deliberately UNBOUNDED: a deadline
    // here would kill the login tab under the user mid-typing.
    const exec = await run([site, 'login', '-f', 'json'], {
      env: { OPENCLI_CDP_ENDPOINT: endpoint },
    });
    const parsed = extractJson(exec.stdout);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const record = (row ?? {}) as Record<string, unknown>;
    const loggedIn =
      exec.exitCode === 0 && (record.logged_in === true || record.status === 'logged_in');
    const account = typeof record.user_name === 'string' ? record.user_name : undefined;
    return { loggedIn, account };
  };

  const dispose = async (): Promise<void> => {
    if (started) await deps.sandbox.dispose();
    started = false;
  };

  return {
    classify,
    invoke,
    login,
    catalogSize: () => meta.size,
    browserEndpoint,
    dispose,
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
