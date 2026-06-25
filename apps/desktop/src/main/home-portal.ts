/**
 * Home portal — Render's default landing page is an opencli-served page.
 *
 * Option B ("opencli is the kernel"): instead of Render hand-rolling a homepage,
 * it spawns `opencli ux serve` (via the opencli-ux ux.mjs), which serves an
 * interactive portal at its OWN isolated origin (http://127.0.0.1:<port>) and
 * exposes the token-gated `/ux/data` route the page uses to pull live data from
 * opencli adapters (bilibili / 36kr / arxiv / binance / wttr / agg). Render just
 * opens that URL in a tab — a thin browser over an opencli page.
 *
 * The server is independent of the opencli daemon's health: the HTML renders even
 * if data widgets error, so the portal always loads. Best-effort: if ux.mjs or the
 * portal html is missing, the portal is disabled and tabs fall back to blank.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/** Read commands the portal page is allowed to run through /ux/data (server-owned allowlist). */
const PORTAL_ALLOW = 'agg search,coingecko top,arxiv recent,36kr news,wttr current';

export interface HomePortal {
  /** The served portal URL once ready, else null (disabled / not yet up). */
  readonly url: string | null;
  /** Resolves with the URL when the server announces it, or null if it never starts. */
  whenReady(): Promise<string | null>;
  /** Kill the portal server. Idempotent. */
  dispose(): void;
}

const DISABLED: HomePortal = { url: null, whenReady: () => Promise.resolve(null), dispose() {} };

/**
 * Resolve ux.mjs: env override → the sibling opencli-ux checkout. (opencli-ux is
 * not a Render dependency; once it ships as an installed opencli plugin this
 * becomes `opencli ux serve` and the path lookup goes away.)
 */
function resolveUxMjs(): string | null {
  const env = process.env.RENDER_PORTAL_UX_MJS?.trim();
  if (env) return existsSync(env) ? env : null;
  const guess = join(homedir(), 'workspace', 'opencli-ux', 'ux.mjs');
  return existsSync(guess) ? guess : null;
}

function resolvePortalHtml(): string | null {
  const env = process.env.RENDER_PORTAL_HTML?.trim();
  if (env) return existsSync(env) ? env : null;
  // dev: __dirname = apps/desktop/out/main → ../../examples/portal.html
  const guess = join(__dirname, '..', '..', 'examples', 'portal.html');
  return existsSync(guess) ? guess : null;
}

/**
 * Resolve the json-render portal spec (opencli-ux/examples/portal-jsonrender-live.json),
 * served via `ux render --spec` through the catalog-whitelisted json-render engine.
 * This is the DEFAULT home now; the raw-HTML portal is the fallback if it's missing.
 */
function resolvePortalSpec(uxMjs: string): string | null {
  const env = process.env.RENDER_PORTAL_SPEC?.trim();
  if (env) return existsSync(env) ? env : null;
  // the fixture lives next to ux.mjs in the opencli-ux checkout.
  const guess = join(dirname(uxMjs), 'examples', 'portal-jsonrender-live.json');
  return existsSync(guess) ? guess : null;
}

export function startHomePortal(opts: { profile?: string } = {}): HomePortal {
  if (process.env.RENDER_HOME_PORTAL === '0') return DISABLED;

  const uxMjs = resolveUxMjs();
  if (!uxMjs) {
    console.warn('[home-portal] ux.mjs not found — home portal disabled, tabs open blank.');
    return DISABLED;
  }
  // Default home = the catalog-whitelisted json-render portal (`render --spec`).
  // Falls back to the raw-HTML portal (`serve --html`) if the spec is missing.
  const spec = resolvePortalSpec(uxMjs);
  const html = resolvePortalHtml();
  const portalArgv = spec
    ? [uxMjs, 'render', '--spec', spec, '--keep', '--allow', PORTAL_ALLOW, '--no-open']
    : html
      ? [uxMjs, 'serve', '--html', html, '--allow', PORTAL_ALLOW, '--no-open']
      : null;
  if (!portalArgv) {
    console.warn('[home-portal] no portal spec or html found — home portal disabled, tabs open blank.');
    return DISABLED;
  }

  let url: string | null = null;
  let resolveReady!: (u: string | null) => void;
  const ready = new Promise<string | null>((r) => {
    resolveReady = r;
  });

  const profile = opts.profile || process.env.OPENCLI_PROFILE || 'render';
  let child: ChildProcess | null = null;
  try {
    child = spawn('node', portalArgv, {
      env: { ...process.env, OPENCLI_PROFILE: profile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.warn('[home-portal] failed to spawn ux serve:', String(err));
    return DISABLED;
  }

  // ux serve announces `{"served":true,"url":"http://127.0.0.1:<port>/...",...}` on its first stdout line.
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    if (url) return;
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    try {
      const j = JSON.parse(buf.slice(0, nl));
      if (j && typeof j.url === 'string') {
        url = j.url;
        resolveReady(url);
      }
    } catch {
      /* keep buffering until a full JSON line arrives */
    }
  });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.warn('[home-portal:ux]', s.slice(0, 200));
  });
  child.on('exit', (code) => {
    if (!url) {
      console.warn(`[home-portal] ux serve exited (code ${code}) before announcing a url — portal disabled.`);
      resolveReady(null);
    }
  });

  return {
    get url() {
      return url;
    },
    whenReady: () => ready,
    dispose() {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
