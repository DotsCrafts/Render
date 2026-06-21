/**
 * OpencliRouter — the APP HAND.
 *
 * Routes an opencli invocation to the right hand:
 *   public/API adapters → @render/sandbox (headless, credential-blind)
 *   browser/cookie      → the real logged-in Chromium via the cdp-human-hand
 *                         relay (OPENCLI_CDP_ENDPOINT, client-pull)
 *
 * Classification comes from real `opencli list -f json` metadata (cached). A
 * not-logged-in browser adapter resolves to `needsLogin` rather than crashing.
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
import { extractJson, extractLoginUrl, isAuthRequired } from './parse.js';
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
    await meta.load(() => run(['list', '-f', 'json']));
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
    classifyCache.set(cacheKey, strategy);
    return strategy;
  };

  const browserEndpoint = async (): Promise<string | null> => {
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

  const invokePublic = async (
    inv: OpencliInvocation,
    strategy: AdapterStrategy,
    format: OpencliFormat,
    argv: string[],
  ): Promise<OpencliResult> => {
    const exec = await run(argv);
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
    const loginUrl = (exec?: OpencliExec): string | undefined =>
      (exec && extractLoginUrl(exec, m?.domain)) ?? (m?.domain ? `https://${m.domain}` : undefined);

    if (!endpoint) {
      // No human-hand wired → we cannot reach the logged-in browser at all.
      return {
        ok: false,
        strategy,
        ranOn: 'cdp-human-hand',
        error: 'no CDP endpoint configured (human-hand unavailable)',
        needsLogin: { site: inv.site, loginUrl: loginUrl() },
      };
    }

    const exec = await run(argv, { env: { OPENCLI_CDP_ENDPOINT: endpoint } });
    if (isAuthRequired(exec)) {
      return {
        ok: false,
        strategy,
        ranOn: 'cdp-human-hand',
        error: 'login required',
        needsLogin: { site: inv.site, loginUrl: loginUrl(exec) },
      };
    }
    return toResult(exec, strategy, 'cdp-human-hand', format);
  };

  const login = async (site: string): Promise<{ loggedIn: boolean; account?: string }> => {
    const endpoint = await browserEndpoint();
    if (!endpoint) {
      throw new Error('login: no CDP endpoint (human-hand required to drive the login tab)');
    }
    // `opencli <site> login` opens the site in the real tab (via the relay) and
    // waits for the human to authenticate.
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
