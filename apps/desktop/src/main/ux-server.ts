/**
 * ux-server — serve json-render specs through the opencli-ux kernel.
 *
 * The unified page-generation path (Option B). The agent produces a json-render
 * SPEC (catalog-whitelisted) and Render serves it via the opencli-ux kernel, then
 * opens the URL as a normal tab. No isolated artifact partition, no custom
 * renderArtifact bridge: the page is a real localhost app whose only backend
 * reach is the ux server's token-gated /ux/data. Reused by home-portal (the home
 * page), pages-store (reopen) and the agent's `render-page` tool.
 *
 * Pages are UPDATABLE: `UxPage.update()` re-serves a revised spec through the
 * same page identity, which is what lets the agent deliver a skeleton early and
 * refine it, or revise an already-delivered page, without minting a new tab.
 * Two backends implement that behind one interface:
 *
 *   • POOLED (preferred): ONE long-lived `ux.mjs pool` process serves MANY specs,
 *     one per route. Adding/revising a page is a `set` op over the pool's stdin
 *     (JSONL) and the page URL is STABLE across revisions, so an update is just a
 *     tab reload — no per-page process at all. Probed once per app run; the
 *     contract ux.mjs implements is docs/ux-pool-protocol.md.
 *
 *   • PER-PAGE (fallback — an ux.mjs without pool mode): each spec gets its own
 *     `ux render --spec … --keep` process. update() spawns a REPLACEMENT server
 *     with the revised spec, waits for its URL, then retires the old process —
 *     the URL changes, so the caller must re-point the page's tab.
 *
 * Either way `--allow` stays the server-owned allowlist of what the page may run
 * through /ux/data (per-route in pool mode).
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
  /**
   * Re-serve a REVISED spec through this page's identity. Resolves with the URL
   * to show — pooled: unchanged (a reload suffices); per-page: a NEW url the
   * caller must re-point the tab to — or null when the revision could not be
   * served (the previous revision keeps serving where possible).
   */
  update(next: { specJson: string; allow?: string }): Promise<string | null>;
  /** Retire the page (kill its server / free its pool route). Idempotent. */
  dispose(): void;
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
}

const DISABLED: UxPage = {
  url: null,
  whenReady: () => Promise.resolve(null),
  update: () => Promise.resolve(null),
  dispose() {},
};

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
      resolveProbe(null);
    });
    child.on('exit', (code) => {
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

// ── per-page backend (fallback) ───────────────────────────────────────────────

interface SpecServer {
  whenReady(): Promise<string | null>;
  dispose(): void;
}

/** One `ux render --spec … --keep` process serving one spec revision. */
function spawnSpecServer(
  uxMjs: string,
  specJson: string,
  allow: string,
  profile: string,
  tag: string,
): SpecServer {
  const DEAD: SpecServer = { whenReady: () => Promise.resolve(null), dispose() {} };
  // ux.mjs --spec reads a FILE path; write the spec to a temp file.
  const specFile = join(tmpdir(), `render-page-${tag}.json`);
  try {
    writeFileSync(specFile, specJson);
  } catch (err) {
    console.warn('[ux-server] failed to write spec file:', String(err));
    return DEAD;
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
    return DEAD;
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
  child.stdout?.on(
    'data',
    lineSplitter((line) => {
      if (url) return;
      try {
        const j = JSON.parse(line) as { url?: unknown };
        if (j && typeof j.url === 'string') {
          url = j.url;
          resolveReady(url);
        }
      } catch {
        /* not the announce line */
      }
    }),
  );
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
    whenReady: () => ready,
    dispose() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * A page with its own server process. update() = spawn a replacement server for
 * the revised spec, wait for its URL, retire the old process. The old revision
 * keeps serving until the new one is up, so a failed revision never takes the
 * page down — but the URL changes on success, so the caller re-points the tab.
 */
function perPagePage(uxMjs: string, opts: ServeUxSpecOpts, profile: string): UxPage {
  let rev = 0;
  let allow = opts.allow;
  let current = spawnSpecServer(uxMjs, opts.specJson, allow, profile, opts.idTag);
  let url: string | null = null;
  let disposed = false;
  const ready = current.whenReady().then((u) => (url = u));
  // updates are serialized: each waits for the previous serve/update to settle.
  let chain: Promise<string | null> = ready;

  return {
    get url() {
      return url;
    },
    whenReady: () => ready,
    update(next) {
      chain = chain.then(async () => {
        if (disposed) return null;
        if (next.allow !== undefined) allow = next.allow;
        const replacement = spawnSpecServer(uxMjs, next.specJson, allow, profile, `${opts.idTag}-r${++rev}`);
        const newUrl = await replacement.whenReady();
        if (!newUrl || disposed) {
          replacement.dispose();
          return null;
        }
        current.dispose();
        current = replacement;
        url = newUrl;
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
 * call-shape and await whenReady() as before.
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
    update: (next) => inner.then((p) => p.update(next)),
    dispose() {
      disposed = true;
      page?.dispose();
    },
  };
}
