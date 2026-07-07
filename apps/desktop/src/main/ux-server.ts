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
 *
 * `watchUxChild` is the single child-readiness watcher shared with home-portal:
 * it scans stdout for the one-line JSON announce, keeps a stderr tail for
 * failure diagnostics, and bounds the wait with a hard deadline so a child that
 * neither announces nor exits can never suspend a caller forever.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/**
 * Resolve ux.mjs: env override → the sibling opencli-ux checkout. The SINGLE
 * source of truth — home-portal imports this, and index.ts probes it at boot to
 * surface a degraded-mode notice when the kernel is missing.
 */
export function resolveUxMjs(): string | null {
  const env = process.env.RENDER_PORTAL_UX_MJS?.trim();
  if (env) return existsSync(env) ? env : null;
  const guess = join(homedir(), 'workspace', 'opencli-ux', 'ux.mjs');
  return existsSync(guess) ? guess : null;
}

/** How long a ux child may take to announce its URL before readiness gives up. */
const READY_TIMEOUT_MS = 12_000;
/** How much trailing stderr to keep for failure diagnostics. */
const STDERR_TAIL_CHARS = 500;

export interface UxPage {
  /** The served URL once ready, else null (disabled / never started). */
  readonly url: string | null;
  /** Resolves with the URL when the server announces it, or null if it never starts. */
  whenReady(): Promise<string | null>;
  /** Last ~500 chars of the child's stderr — the WHY when a page fails to start. */
  stderrTail(): string;
  /** Kill the ux server (and delete its temp spec file). Idempotent. */
  dispose(): void;
}

const DISABLED: UxPage = {
  url: null,
  whenReady: () => Promise.resolve(null),
  stderrTail: () => '',
  dispose() {},
};

/**
 * Watch a spawned ux child for its one-line JSON announce (`{"url": …}`) on
 * stdout. Iterates over ALL complete lines and slices consumed data off the
 * buffer — a banner line before the announce is skipped, never re-parsed
 * forever (the old scanner wedged on the first non-JSON line). Readiness is
 * bounded: if the child neither announces nor exits within `deadlineMs`, the
 * ready promise resolves null and the child is killed.
 */
export function watchUxChild(
  child: ChildProcess,
  opts: { label: string; deadlineMs?: number; onDispose?: () => void },
): UxPage {
  let url: string | null = null;
  let stderrBuf = '';
  let settled = false;
  let resolveReady!: (u: string | null) => void;
  const ready = new Promise<string | null>((r) => {
    resolveReady = r;
  });

  const settle = (u: string | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    resolveReady(u);
  };

  const deadlineMs = opts.deadlineMs ?? READY_TIMEOUT_MS;
  const deadline = setTimeout(() => {
    if (settled) return;
    console.warn(`[${opts.label}] ux child announced no url within ${deadlineMs}ms — giving up.`);
    settle(null);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, deadlineMs);

  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    if (url) return;
    buf += d.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0 && !url) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const j = JSON.parse(line) as { url?: unknown };
        if (j && typeof j.url === 'string') {
          url = j.url;
          settle(url);
        }
      } catch {
        /* non-JSON banner line — skip it and keep scanning */
      }
      nl = buf.indexOf('\n');
    }
  });

  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString();
    stderrBuf = (stderrBuf + s).slice(-STDERR_TAIL_CHARS);
    const t = s.trim();
    if (t) console.warn(`[${opts.label}:ux]`, t.slice(0, 200));
  });

  // 'error' fires on async spawn failure (ENOENT etc.) where 'exit' never does;
  // 'close' (not 'exit') waits for stdio to drain, so the stderr tail is
  // complete by the time a failed readiness resolves.
  child.on('error', (err) => {
    if (settled) return;
    console.warn(`[${opts.label}] ux child failed to spawn:`, String(err));
    settle(null);
  });
  child.on('close', (code) => {
    if (settled) return;
    console.warn(`[${opts.label}] ux child exited (code ${code}) before announcing a url.`);
    settle(null);
  });

  return {
    get url() {
      return url;
    },
    whenReady: () => ready,
    stderrTail: () => stderrBuf,
    dispose() {
      settle(null); // unblock any pending whenReady caller
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      try {
        opts.onDispose?.();
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

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
  /** override the announce deadline (tests only) */
  readyTimeoutMs?: number;
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
  let child: ChildProcess;
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

  return watchUxChild(child, {
    label: 'ux-server',
    ...(opts.readyTimeoutMs !== undefined ? { deadlineMs: opts.readyTimeoutMs } : {}),
    // the temp spec file is one-shot input (ux.mjs reads it at startup) — it
    // goes when the server does, instead of accreting in tmpdir forever.
    onDispose: () => {
      try {
        unlinkSync(specFile);
      } catch {
        /* already gone */
      }
    },
  });
}
