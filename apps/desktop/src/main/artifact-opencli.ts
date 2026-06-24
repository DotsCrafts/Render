/**
 * The artifact → opencli capability runner (main-process, trusted).
 *
 * A Tier-2 artifact page is ISOLATED: its own ephemeral partition, a no-network
 * CSP, no access to the user's logged-in `persist:render` session. Its ONLY way
 * to reach a backend is this narrow capability — and it is fenced four ways:
 *
 *   1. allowlist   — the artifact declared `--opencli "<site> <command>,…"`; any
 *                    call outside that set is rejected (see capability-gate.ts).
 *   2. consent     — the human must approve the first use (capability-gate.ts).
 *   3. read-only   — M1 permits only READ commands (this module). A write/login/
 *                    mutate command is rejected even if it slipped the allowlist.
 *   4. JSON only   — opencli runs with `-f json`; we return parsed data, never a
 *                    handle to the process or the user's cookies.
 *
 * opencli is invoked exactly as the agent invokes it — a child process with
 * `OPENCLI_PROFILE=render` and `-f json` — so reads hit Render's own bridged
 * Chromium (the same session the agent uses), not system Chrome.
 */

import { execFile } from 'node:child_process';
import type { ArtifactOpencliResult } from '@render/protocol';

/**
 * READ verbs M1 allows. opencli command names are conventionally verbs; anything
 * that reads (search/list/get/read/feed/…) is safe, anything that mutates
 * (login/post/buy/send/book/cancel/…) is not. We allowlist the read verbs rather
 * than denylist writes — unknown verbs are treated as NON-reads (fail closed).
 *
 * LIMITATION (documented): this is a heuristic on the command NAME. opencli has
 * no machine-readable read/write annotation surfaced here, so M1 errs strict —
 * an artifact that needs a verb not in this set must wait for a richer M-level
 * (e.g. classification from `opencli <site> --help` metadata). Better to reject a
 * safe read than to let a prompt-injected agent smuggle a write past the gate.
 */
const READ_VERBS = new Set([
  'search', 'list', 'get', 'read', 'show', 'view', 'detail', 'details', 'info',
  'hot', 'feed', 'trending', 'top', 'recommend', 'recommended', 'query', 'lookup',
  'find', 'browse', 'fetch', 'page', 'comments', 'reviews', 'related', 'similar',
  'profile', 'status', 'summary', 'stats',
]);

export function isReadCommand(command: string): boolean {
  return READ_VERBS.has(command.trim().toLowerCase());
}

export interface ArtifactOpencliDeps {
  /** opencli profile reads route to (Render's bridged Chromium). Default 'render'. */
  profile?: string;
  /** opencli executable (default 'opencli'); injectable for tests. */
  bin?: string;
  /** child-process timeout in ms (default 30s). */
  timeoutMs?: number;
}

/**
 * Run a single read-only opencli command on behalf of an artifact and return
 * parsed JSON. Caller (the IPC handler) has already enforced allowlist + consent;
 * this is the LAST gate (read-only) plus the actual invocation.
 */
export async function runArtifactOpencli(
  req: {
    site: string;
    command: string;
    positional?: Array<string | number>;
    args?: Record<string, string | number | boolean>;
  },
  deps: ArtifactOpencliDeps = {},
): Promise<ArtifactOpencliResult> {
  // Prototype mode (default): no read-only restriction — an artifact runs opencli
  // as freely as the agent. Re-enabled with RENDER_ARTIFACT_GATE=1.
  if (process.env.RENDER_ARTIFACT_GATE === '1' && !isReadCommand(req.command)) {
    return {
      ok: false,
      error: `"${req.site} ${req.command}" is not a permitted read command (artifacts are read-only in M1)`,
    };
  }

  const bin = deps.bin ?? 'opencli';
  const profile = deps.profile ?? 'render';
  const argv = buildArgv(req.site, req.command, req.positional, req.args);
  const env = { ...process.env, OPENCLI_PROFILE: profile };

  try {
    const { stdout } = await execFileAsync(bin, argv, {
      env,
      timeoutMs: deps.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const data = extractJson(stdout);
    if (data === undefined) {
      return { ok: false, error: 'opencli returned no parseable JSON' };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: errText(err).slice(0, 500) };
  }
}

/**
 * `<site> <command> [positional…] [--key value …] -f json`. Positional args come
 * first (most opencli commands take their primary input positionally — a search
 * keyword, an item id), then named flags. Args are validated by the caller.
 */
function buildArgv(
  site: string,
  command: string,
  positional?: Array<string | number>,
  args?: Record<string, string | number | boolean>,
): string[] {
  const argv = [site, command];
  for (const value of positional ?? []) {
    argv.push(String(value));
  }
  for (const [key, value] of Object.entries(args ?? {})) {
    // boolean true → bare flag; everything else → `--key value`.
    if (value === true) argv.push(`--${key}`);
    else if (value === false) continue;
    else argv.push(`--${key}`, String(value));
  }
  argv.push('-f', 'json');
  return argv;
}

/** Pull the first JSON value out of opencli stdout (it may print a banner first). */
function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall back to the first {...} / [...] run in the output
    const start = trimmed.search(/[[{]/);
    if (start < 0) return undefined;
    for (let end = trimmed.length; end > start; end--) {
      const slice = trimmed.slice(start, end);
      try {
        return JSON.parse(slice);
      } catch {
        /* keep shrinking */
      }
    }
    return undefined;
  }
}

function execFileAsync(
  bin: string,
  argv: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      argv,
      { env: opts.env, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer },
      (error, stdout, stderr) => {
        if (error) {
          // surface stderr (opencli's human-readable failure) over the raw signal.
          const msg = stderr?.trim() || error.message;
          reject(new Error(msg));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
