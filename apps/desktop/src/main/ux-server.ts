/**
 * ux-server — serve json-render specs through the opencli-ux kernel.
 *
 * The unified page-generation path (Option B). The agent produces a json-render
<<<<<<< HEAD
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
=======
 * SPEC (catalog-whitelisted) and Render serves it via the opencli-ux kernel, then
 * opens the URL as a normal tab. No isolated artifact partition, no custom
 * renderArtifact bridge: the page is a real localhost app whose only backend
 * reach is the ux server's token-gated /ux/data. Reused by home-portal (the home
 * page), pages-store (reopen) and the agent's `render-page` tool.
 *
 * `watchUxChild` is the single child-readiness watcher shared with home-portal:
 * it scans stdout for the one-line JSON announce, keeps a stderr tail for
 * failure diagnostics, and bounds the wait with a hard deadline so a child that
 * neither announces nor exits can never suspend a caller forever.
 *
 * Pages served here are UPDATABLE: `UxPage.update()` re-serves a revised spec
 * through the same page identity, which is what lets the agent deliver a
 * skeleton early and refine it, or revise an already-delivered page, without
 * minting a new tab. Two backends implement that behind one interface:
 *
 *   • POOLED (preferred): ONE long-lived `ux.mjs pool` process serves MANY specs,
 *     one per route. Adding/revising a page is a `set` op over the pool's stdin
 *     (JSONL) and the page URL is STABLE across revisions, so an update is just a
 *     tab reload — no per-page process at all. Probed once per app run; the
 *     contract ux.mjs implements is docs/ux-pool-protocol.md.
 *
 *   • PER-PAGE (fallback — an ux.mjs without pool mode): each spec revision gets
 *     its own `ux render --spec … --keep` process (`watchUxChild` above).
 *     update() spawns a REPLACEMENT server for the revised spec, waits for its
 *     URL, then retires the old process — the URL changes, so the caller
 *     re-points the page's tab.
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
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

/**
 * A watched ux child: a single running kernel process serving one spec. This is
 * what `watchUxChild` returns and what home-portal consumes directly.
 */
export interface UxChild {
  /** The served URL once ready, else null (disabled / never started). */
  readonly url: string | null;
  /** The kernel's session id once ready (correlates confirm-broker requests). */
  readonly session: string | null;
  /** Resolves with the URL when the server announces it, or null if it never starts. */
  whenReady(): Promise<string | null>;
  /** Last ~500 chars of the child's stderr — the WHY when a page fails to start. */
  stderrTail(): string;
  /** Kill the ux server (and delete its temp spec file). Idempotent. */
  dispose(): void;
}

<<<<<<< HEAD
const DISABLED: UxPage = {
  url: null,
  session: null,
  whenReady: () => Promise.resolve(null),
=======
/**
 * A served, UPDATABLE page — a `UxChild` plus `update()`. `serveUxSpec` and
 * `pages-store.reopen` return this; the agent runtime revises pages through it.
 */
export interface UxPage extends UxChild {
  /**
   * Re-serve a REVISED spec through this page's identity. Resolves with the URL
   * to show — pooled: unchanged (a reload suffices); per-page: a NEW url the
   * caller must re-point the tab to — or null when the revision could not be
   * served (the previous revision keeps serving where possible).
   */
  update(next: { specJson: string; allow?: string }): Promise<string | null>;
}

const DISABLED: UxPage = {
  url: null,
  whenReady: () => Promise.resolve(null),
  stderrTail: () => '',
  update: () => Promise.resolve(null),
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
  dispose() {},
};

/**
<<<<<<< HEAD
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
=======
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
): UxChild {
  let url: string | null = null;
  let stderrBuf = '';
  let settled = false;
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
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

<<<<<<< HEAD
  // ux render --keep announces `{"rendered":true,"url":"…","keep":true}` on its
  // FIRST stdout line, then streams one JSONL line per page action (/ux/callback
  // payload). Keep parsing past the announce and forward each payload.
=======
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
<<<<<<< HEAD
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
=======
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
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
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
    get session() {
      return session;
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

export interface ServeUxSpecOpts {
  /** the json-render spec, as a JSON string */
  specJson: string;
  /** server-owned allowlist: "<site> <command>,…" the page may run via /ux/data */
  allow: string;
  /** OPENCLI_PROFILE the ux server runs under (Render's bridge profile) */
  profile?: string;
  /** unique tag for the temp spec file name / pool route */
  idTag: string;
  /** override the announce deadline (tests only) */
  readyTimeoutMs?: number;
}

/**
 * Spawn a single `ux render --spec … --keep` child for one spec revision and
 * watch it to readiness. The temp spec file is one-shot input (ux.mjs reads it
 * at startup) and is unlinked on dispose so it doesn't accrete in tmpdir.
 */
function spawnPerPageChild(
  uxMjs: string,
  specJson: string,
  allow: string,
  profile: string,
  tag: string,
  readyTimeoutMs?: number,
): UxChild {
  const dead: UxChild = { url: null, whenReady: () => Promise.resolve(null), stderrTail: () => '', dispose() {} };
  const specFile = join(tmpdir(), `render-page-${tag}.json`);
  try {
    writeFileSync(specFile, specJson);
  } catch (err) {
    console.warn('[ux-server] failed to write spec file:', String(err));
    return dead;
  }

  let child: ChildProcess;
  try {
    child = spawn(
      'node',
      [uxMjs, 'render', '--spec', specFile, '--keep', '--allow', allow, '--no-open'],
      { env: { ...process.env, OPENCLI_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    console.warn('[ux-server] failed to spawn ux render:', String(err));
    try {
      unlinkSync(specFile);
    } catch {
      /* already gone */
    }
    return dead;
  }

  return watchUxChild(child, {
    label: 'ux-server',
    ...(readyTimeoutMs !== undefined ? { deadlineMs: readyTimeoutMs } : {}),
    onDispose: () => {
      try {
        unlinkSync(specFile);
      } catch {
        /* already gone */
      }
    },
  });
}

/**
 * A page with its own server process. update() = spawn a replacement server for
 * the revised spec, wait for its URL, retire the old process. The old revision
 * keeps serving until the new one is up, so a failed revision never takes the
 * page down — but the URL changes on success, so the caller re-points the tab.
 * url/stderrTail delegate to the CURRENT child so the runtime's error path reads
 * the live child's diagnostics.
 */
function perPagePage(uxMjs: string, opts: ServeUxSpecOpts, profile: string): UxPage {
  let rev = 0;
  let allow = opts.allow;
  let current = spawnPerPageChild(uxMjs, opts.specJson, allow, profile, opts.idTag, opts.readyTimeoutMs);
  let disposed = false;
  const ready = current.whenReady();
  // updates are serialized: each waits for the previous serve/update to settle.
  let chain: Promise<string | null> = ready;

  return {
    get url() {
      return current.url;
    },
    whenReady: () => ready,
    stderrTail: () => current.stderrTail(),
    update(next) {
      chain = chain.then(async () => {
        if (disposed) return null;
        if (next.allow !== undefined) allow = next.allow;
        const replacement = spawnPerPageChild(
          uxMjs,
          next.specJson,
          allow,
          profile,
          `${opts.idTag}-r${++rev}`,
          opts.readyTimeoutMs,
        );
        const newUrl = await replacement.whenReady();
        if (!newUrl || disposed) {
          replacement.dispose();
          return null;
        }
        current.dispose();
        current = replacement;
        return newUrl;
      });
      return chain;
    },
    dispose() {
      disposed = true;
      current.dispose();
    },
  };
}

// ── pooled backend ────────────────────────────────────────────────────────────

/** How long the pool child gets to announce `{"pooled":true}` before we fall back. */
const POOL_ANNOUNCE_TIMEOUT_MS = 3_000;
/** How long a set/delete op may wait for its ack before the pool is retired. */
const POOL_ACK_TIMEOUT_MS = 15_000;

interface UxPool {
  readonly alive: boolean;
  /** Serve (or hot-swap) a spec at `route`; resolves with the page URL or null. */
  setPage(route: string, spec: unknown, allow: string): Promise<string | null>;
  /** Free a route. Fire-and-forget. */
  deletePage(route: string): void;
  dispose(): void;
}

/** Feed stream chunks in, get whole trimmed non-empty lines out. */
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

/**
 * Spawn `ux.mjs pool` and wait for its announce line (docs/ux-pool-protocol.md).
 * Resolves null when the installed ux.mjs predates pool mode — it exits on the
 * unknown command, announces something that isn't `{"pooled":true}`, or says
 * nothing within the probe timeout — and the caller falls back to per-page
 * servers for the rest of the app run.
 */
function startPool(uxMjs: string, profile: string): Promise<UxPool | null> {
  let child: ChildProcess;
  try {
    child = spawn('node', [uxMjs, 'pool', '--no-open'], {
      env: { ...process.env, OPENCLI_PROFILE: profile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.warn('[ux-server] failed to spawn ux pool:', String(err));
    return Promise.resolve(null);
  }

  let alive = false;
  let announced = false;
  // Ops are serialized through `queue`, so at most one is in flight and the next
  // ack line always belongs to `pending`.
  let pending: { resolve: (ack: Record<string, unknown> | null) => void; timer: NodeJS.Timeout } | null =
    null;
  let queue: Promise<unknown> = Promise.resolve();

  const kill = (): void => {
    alive = false;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      pending = null;
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };

  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.warn('[ux-server:pool]', s.slice(0, 200));
  });

  const probe = new Promise<UxPool | null>((resolveProbe) => {
    const probeTimer = setTimeout(() => {
      if (!announced) {
        kill();
        resolveProbe(null);
      }
    }, POOL_ANNOUNCE_TIMEOUT_MS);

    child.on('error', (err) => {
      console.warn('[ux-server] failed to spawn ux pool:', String(err));
      clearTimeout(probeTimer);
      kill();
      if (!announced) resolveProbe(null);
    });
    child.on('close', (code) => {
      alive = false;
      if (!announced) {
        clearTimeout(probeTimer);
        resolveProbe(null); // an ux.mjs without pool mode exits here → per-page fallback
        return;
      }
      console.warn(`[ux-server] ux pool exited (code ${code}) — new pages fall back to per-page servers.`);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(null);
        pending = null;
      }
    });

    child.stdout?.on(
      'data',
      lineSplitter((line) => {
        let j: Record<string, unknown> | null;
        try {
          j = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // stray non-JSON output — keep reading
        }
        if (!announced) {
          // STRICT: only a `{"pooled":true}` announce counts. Anything else (usage
          // text as JSON, an older ux.mjs's `served` announce) → not pool-capable.
          clearTimeout(probeTimer);
          if (j && j.pooled === true) {
            announced = true;
            alive = true;
            resolveProbe(pool);
          } else {
            kill();
            resolveProbe(null);
          }
          return;
        }
        if (pending) {
          clearTimeout(pending.timer);
          const p = pending;
          pending = null;
          p.resolve(j);
        }
      }),
    );
  });

  const send = (op: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const run = (): Promise<Record<string, unknown> | null> =>
      new Promise((resolve) => {
        if (!alive || !child.stdin?.writable) return resolve(null);
        pending = {
          resolve,
          // A lost ack means op↔reply pairing is broken — retire the pool (new
          // pages fall back to per-page) rather than desync the whole protocol.
          timer: setTimeout(() => {
            console.warn('[ux-server] ux pool ack timeout — retiring the pool.');
            kill();
          }, POOL_ACK_TIMEOUT_MS),
        };
        child.stdin.write(`${JSON.stringify(op)}\n`, (err) => {
          if (err && pending) {
            clearTimeout(pending.timer);
            pending = null;
            resolve(null);
          }
        });
      });
    const next = queue.then(run, run);
    queue = next;
    return next;
  };

  const pool: UxPool = {
    get alive() {
      return alive;
    },
    async setPage(route, spec, allow) {
      const ack = await send({ op: 'set', route, spec, allow });
      return ack && ack.ok === true && typeof ack.url === 'string' ? ack.url : null;
    },
    deletePage(route) {
      void send({ op: 'delete', route });
    },
    dispose: kill,
  };

  return probe;
}

/** A page served by the pool: stable URL, update = hot-swap the route's spec. */
function poolPage(pool: UxPool, route: string, opts: ServeUxSpecOpts): UxPage {
  let url: string | null = null;
  let allow = opts.allow;
  let disposed = false;

  const set = (specJson: string): Promise<string | null> => {
    let spec: unknown;
    try {
      spec = JSON.parse(specJson);
    } catch {
      return Promise.resolve(null); // callers validate, but never ship garbage to the pool
    }
    return pool.setPage(route, spec, allow);
  };

  const ready = set(opts.specJson).then((u) => (url = u));
  // updates are serialized: each waits for the previous serve/update to settle.
  let chain: Promise<string | null> = ready;

  return {
    get url() {
      return url;
    },
    whenReady: () => ready,
    stderrTail: () => '', // pooled pages share one process — no per-page stderr tail
    update(next) {
      chain = chain.then(() => {
        if (disposed) return null;
        if (next.allow !== undefined) allow = next.allow;
        // same route → same URL: the caller's tab just needs a reload, not a re-point.
        return set(next.specJson).then((u) => (u ? (url = u) : null));
      });
      return chain;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pool.alive) pool.deletePage(route);
    },
  };
}

// ── backend selection ─────────────────────────────────────────────────────────

type Backend = { kind: 'pool'; pool: UxPool } | { kind: 'per-page' };

let backendPromise: Promise<Backend> | null = null;

/**
 * Pick the backend once per app run, lazily on the first page (whose profile the
 * pool inherits — every caller passes Render's bridge profile in practice). Pool
 * mode is preferred; RENDER_UX_POOL=0 skips the probe. A pool that dies later
 * demotes new pages to per-page servers (pages already served by it die with it
 * and are re-delivered fresh by their owners via update() → null).
 */
function resolveBackend(uxMjs: string, profile: string): Promise<Backend> {
  if (!backendPromise) {
    backendPromise =
      process.env.RENDER_UX_POOL === '0'
        ? Promise.resolve<Backend>({ kind: 'per-page' })
        : startPool(uxMjs, profile).then((pool): Backend => {
            if (pool) {
              console.log('[ux-server] pooled ux server active — pages share one process.');
              return { kind: 'pool', pool };
            }
            return { kind: 'per-page' };
          });
  }
  return backendPromise.then((b) => {
    if (b.kind === 'pool' && !b.pool.alive) {
      const demoted: Backend = { kind: 'per-page' };
      backendPromise = Promise.resolve(demoted);
      return demoted;
    }
    return b;
  });
}

/** Kill the pooled ux server, if one is running. The next page re-probes. */
export function disposeUxHost(): void {
  const p = backendPromise;
  backendPromise = null;
  void p?.then((b) => {
    if (b.kind === 'pool') b.pool.dispose();
  });
}

/**
 * Serve a json-render spec and resolve its URL. Best-effort: disabled cleanly if
 * ux.mjs is missing. Backend selection is async (the pool is probed once,
 * lazily), so this hands back a facade immediately — callers keep their sync
 * call-shape and await whenReady() as before, and get a real page whether the
 * pool is up or the per-page fallback took over.
 */
export function serveUxSpec(opts: ServeUxSpecOpts): UxPage {
  const uxMjs = resolveUxMjs();
  if (!uxMjs) {
    console.warn('[ux-server] ux.mjs not found — page disabled.');
    return DISABLED;
  }
  const profile = opts.profile || process.env.OPENCLI_PROFILE || 'render';
  const route = `pg-${opts.idTag}`.replace(/[^a-zA-Z0-9_-]/g, '');
  const inner: Promise<UxPage> = resolveBackend(uxMjs, profile).then((backend) =>
    backend.kind === 'pool' ? poolPage(backend.pool, route, opts) : perPagePage(uxMjs, opts, profile),
  );

  let page: UxPage | null = null;
  let disposed = false;
  void inner.then((p) => {
    page = p;
    if (disposed) p.dispose();
  });
  return {
    get url() {
      return page?.url ?? null;
    },
    whenReady: () => inner.then((p) => p.whenReady()),
    stderrTail: () => page?.stderrTail() ?? '',
    update: (next) => inner.then((p) => p.update(next)),
    dispose() {
      disposed = true;
      page?.dispose();
    },
  };
}
