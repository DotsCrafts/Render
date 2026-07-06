/**
 * ux-server — serve a json-render spec through the opencli-ux kernel.
 *
 * The unified page-generation path (Option B). The agent produces a json-render
 * SPEC (catalog-whitelisted), and Render serves it via `ux render --spec … --keep
 * --allow … --no-open` (the same kernel the home portal uses), then opens the URL
 * as a normal tab. No isolated artifact partition, no custom renderArtifact bridge:
 * the page is a real localhost app whose only backend reach is the ux server's
 * token-gated /ux/data. Reused by home-portal (the home page) and the agent's
 * `render-page` tool (generated pages).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** Resolve ux.mjs: env override → the sibling opencli-ux checkout. */
export function resolveUxMjs(): string | null {
  const env = process.env.RENDER_PORTAL_UX_MJS?.trim();
  if (env) return existsSync(env) ? env : null;
  const guess = join(homedir(), 'workspace', 'opencli-ux', 'ux.mjs');
  return existsSync(guess) ? guess : null;
}

export interface UxPage {
  /** The served URL once ready, else null (disabled / never started). */
  readonly url: string | null;
  /** Resolves with the URL when the server announces it, or null if it never starts. */
  whenReady(): Promise<string | null>;
  /** Kill the ux server. Idempotent. */
  dispose(): void;
}

const DISABLED: UxPage = { url: null, whenReady: () => Promise.resolve(null), dispose() {} };

/**
 * Spawn a long-lived `ux render --spec` server for a json-render spec and resolve
 * its URL. `argv` is `[uxMjs, 'render', '--spec', file, '--keep', '--allow', allow,
 * '--no-open']`. Best-effort: disabled cleanly if ux.mjs is missing or the spec
 * can't be written.
 */
export function serveUxSpec(opts: {
  /** the json-render spec, as a JSON string */
  specJson: string;
  /** server-owned allowlist: "<site> <command>,…" the page may run via /ux/data */
  allow: string;
  /** OPENCLI_PROFILE the ux server runs under (Render's bridge profile) */
  profile?: string;
  /** unique tag for the temp spec file name */
  idTag: string;
}): UxPage {
  const uxMjs = resolveUxMjs();
  if (!uxMjs) {
    console.warn('[ux-server] ux.mjs not found — page disabled.');
    return DISABLED;
  }
  // ux.mjs --spec reads a FILE path; write the agent's spec to a temp file.
  const specFile = join(tmpdir(), `render-page-${opts.idTag}.json`);
  try {
    writeFileSync(specFile, opts.specJson);
  } catch (err) {
    console.warn('[ux-server] failed to write spec file:', String(err));
    return DISABLED;
  }

  const profile = opts.profile || process.env.OPENCLI_PROFILE || 'render';
  let child: ChildProcess | null = null;
  try {
    child = spawn(
      'node',
      [uxMjs, 'render', '--spec', specFile, '--keep', '--allow', opts.allow, '--no-open'],
      { env: { ...process.env, OPENCLI_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    console.warn('[ux-server] failed to spawn ux render:', String(err));
    return DISABLED;
  }

  let url: string | null = null;
  let resolveReady!: (u: string | null) => void;
  const ready = new Promise<string | null>((r) => {
    resolveReady = r;
  });

  // spawn-time ENOENT (e.g. `node` not on PATH when launched from Finder)
  // surfaces as an async 'error' event — without a handler it would CRASH the
  // main process. Degrade like every other missing-dependency path.
  child.on('error', (err) => {
    console.warn('[ux-server] failed to spawn ux render:', String(err));
    resolveReady(null);
  });

  // ux render --keep announces `{"rendered":true,"url":"…","keep":true}` on stdout.
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
      /* keep buffering */
    }
  });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.warn('[ux-server:ux]', s.slice(0, 200));
  });
  child.on('exit', (code) => {
    if (!url) {
      console.warn(`[ux-server] ux render exited (code ${code}) before announcing a url.`);
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
