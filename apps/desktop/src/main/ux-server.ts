/**
 * ux-server — serve a json-render spec through the opencli-ux kernel.
 *
 * The unified page-generation path (Option B). The agent produces a json-render
 * SPEC (catalog-whitelisted), and Render serves it via `ux render --spec … --keep
 * --allow … --no-open` (the same kernel the home portal uses), then opens the URL
 * as a normal tab. No isolated artifact partition, no custom renderArtifact bridge:
 * the page is a real localhost app whose backend reach is the ux server's
 * token-gated /ux/data — reads via `--allow`, writes only via per-command
 * `--allow-write` grants that the kernel brokers through Render's confirm
 * endpoint (one human approval per invocation). Reused by home-portal (the home
 * page) and the agent's `render-page` tool (generated pages).
 *
 * WRITE PATH (genpage-write-path): `ux render --keep` emits every /ux/callback
 * payload the page posts (ux_submit / ux_confirm) as a JSONL line on stdout
 * after the announce line. We keep parsing stdout and hand each payload to
 * `onCallback`, which the agent-runtime forwards into the conversation.
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
  /** The kernel's session id once ready (correlates confirm-broker requests). */
  readonly session: string | null;
  /** Resolves with the URL when the server announces it, or null if it never starts. */
  whenReady(): Promise<string | null>;
  /** Kill the ux server. Idempotent. */
  dispose(): void;
}

const DISABLED: UxPage = {
  url: null,
  session: null,
  whenReady: () => Promise.resolve(null),
  dispose() {},
};

/**
 * Spawn a long-lived `ux render --spec` server for a json-render spec and resolve
 * its URL. `argv` is `[uxMjs, 'render', '--spec', file, '--keep', '--allow', allow,
 * ('--allow-write', allowWrite,) '--no-open']`. Best-effort: disabled cleanly if
 * ux.mjs is missing or the spec can't be written.
 */
export function serveUxSpec(opts: {
  /** the json-render spec, as a JSON string */
  specJson: string;
  /** server-owned allowlist: "<site> <command>,…" the page may run via /ux/data */
  allow: string;
  /**
   * per-command WRITE grants "<site> <command>,…" — each invocation is brokered
   * through `confirm` before it runs (no confirm endpoint ⇒ the kernel refuses
   * all writes, fail closed).
   */
  allowWrite?: string;
  /** Render's confirm-broker endpoint + token, injected into the kernel's env */
  confirm?: { url: string; token: string };
  /**
   * receives every page action the kernel streams after the announce line
   * (keep-mode JSONL: ux_submit values / ux_confirm choice / …).
   */
  onCallback?: (payload: unknown) => void;
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
  const allowWrite = opts.allowWrite?.trim();
  const argv = [uxMjs, 'render', '--spec', specFile, '--keep', '--allow', opts.allow];
  if (allowWrite) argv.push('--allow-write', allowWrite);
  argv.push('--no-open');
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCLI_PROFILE: profile };
  if (opts.confirm) {
    env.OPENCLI_UX_CONFIRM_URL = opts.confirm.url;
    env.OPENCLI_UX_CONFIRM_TOKEN = opts.confirm.token;
  } else {
    // never inherit a stale broker from Render's own environment
    delete env.OPENCLI_UX_CONFIRM_URL;
    delete env.OPENCLI_UX_CONFIRM_TOKEN;
  }
  let child: ChildProcess | null = null;
  try {
    child = spawn('node', argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.warn('[ux-server] failed to spawn ux render:', String(err));
    return DISABLED;
  }

  let url: string | null = null;
  let session: string | null = null;
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

  // ux render --keep announces `{"rendered":true,"url":"…","keep":true}` on its
  // FIRST stdout line, then streams one JSONL line per page action (/ux/callback
  // payload). Keep parsing past the announce and forward each payload.
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j: unknown;
      try {
        j = JSON.parse(line);
      } catch {
        continue; // stray non-JSON noise — never kills the stream
      }
      if (!url) {
        const a = j as { url?: unknown; session?: unknown };
        if (a && typeof a.url === 'string') {
          url = a.url;
          if (typeof a.session === 'string') session = a.session;
          resolveReady(url);
        }
        continue;
      }
      try {
        opts.onCallback?.(j);
      } catch (err) {
        console.warn('[ux-server] onCallback failed:', String(err));
      }
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
    get session() {
      return session;
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
