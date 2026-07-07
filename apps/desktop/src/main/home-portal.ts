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
 *
 * Child readiness (stdout announce scan, stderr tail, hard deadline) is shared
 * with the generated-page path — see `watchUxChild` in ux-server.ts. The ux.mjs
 * resolver lives there too (single source of truth; once opencli-ux ships as an
 * installed opencli plugin this becomes `opencli ux serve` and the lookup goes
 * away).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { resolveUxMjs, watchUxChild } from './ux-server.js';

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

function resolvePortalHtml(): string | null {
  const env = process.env.RENDER_PORTAL_HTML?.trim();
  if (env) return existsSync(env) ? env : null;
  // dev: __dirname = apps/desktop/out/main → ../../examples/portal.html
  // packaged: examples/ is asarUnpacked because the html is read by the
  // EXTERNAL ux.mjs process, which cannot see inside the asar.
  const guess = join(__dirname, '..', '..', 'examples', 'portal.html').replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
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

  const profile = opts.profile || process.env.OPENCLI_PROFILE || 'render';
  let child: ChildProcess;
  try {
    child = spawn('node', portalArgv, {
      env: { ...process.env, OPENCLI_PROFILE: profile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.warn('[home-portal] failed to spawn ux serve:', String(err));
    return DISABLED;
  }

  // ux announces `{"url":"http://127.0.0.1:<port>/…",…}` as a JSON stdout line;
  // the shared watcher scans every line, bounds the wait, and keeps stderr.
  return watchUxChild(child, { label: 'home-portal' });
}
