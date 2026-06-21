/**
 * local-seatbelt SandboxProvider — the DEFAULT, keyless sandbox hand.
 *
 * The BRAIN (codex app-server) and any opencli/shell commands run in a jailed
 * working directory. Two layers of confinement:
 *
 *   1. `exec()` wraps one-shot commands in macOS `sandbox-exec` with a
 *      workspace-write profile (read + network, writes confined to the jail).
 *   2. `spawn()` launches long-lived processes (the brain) rooted in the jail.
 *      The brain is NOT wrapped in seatbelt itself — it needs the network for
 *      the model API and creates its OWN seatbelt children for every shell
 *      command via codex's `sandbox: 'workspace-write'` thread mode. That is the
 *      "run the brain + commands via codex's own OS sandbox" design.
 *
 * Plane-2 web credentials NEVER enter this sandbox (see agent-bridge env policy).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  ExecResult,
  SandboxProcess,
  SandboxProvider,
  SandboxSpawnOptions,
} from '@render/protocol';
import { wrapNodeProcess } from './process.js';
import { resolveWritableRoots, seatbeltProfile } from './seatbelt.js';

const isDarwin = process.platform === 'darwin';

export interface LocalSeatbeltOptions {
  /** disable seatbelt wrapping for exec (e.g. on non-macOS); auto on non-darwin */
  disableSeatbelt?: boolean;
}

export class LocalSeatbeltSandbox implements SandboxProvider {
  readonly id = 'local-seatbelt' as const;

  #workdir: string | null = null;
  #ownsWorkdir = false;
  #baseEnv: Record<string, string> = {};
  readonly #seatbelt: boolean;

  constructor(opts: LocalSeatbeltOptions = {}) {
    this.#seatbelt = isDarwin && !opts.disableSeatbelt;
  }

  async start(opts: SandboxSpawnOptions = {}): Promise<void> {
    if (opts.cwd) {
      await mkdir(opts.cwd, { recursive: true });
      this.#workdir = opts.cwd;
      this.#ownsWorkdir = false;
    } else {
      this.#workdir = await mkdtemp(join(tmpdir(), 'render-sbx-'));
      this.#ownsWorkdir = true;
    }
    this.#baseEnv = { ...(opts.env ?? {}) };
  }

  workdir(): string {
    if (!this.#workdir) throw new Error('LocalSeatbeltSandbox: start() not called');
    return this.#workdir;
  }

  async exec(cmd: string, args: string[], opts: SandboxSpawnOptions = {}): Promise<ExecResult> {
    const cwd = this.#resolveCwd(opts);
    const env = this.#buildEnv(opts);

    let program = cmd;
    let argv = args;
    if (this.#seatbelt) {
      const profile = seatbeltProfile(await resolveWritableRoots(cwd));
      program = 'sandbox-exec';
      argv = ['-p', profile, cmd, ...args];
    }

    return await new Promise<ExecResult>((resolve, reject) => {
      const child = nodeSpawn(program, argv, { cwd, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    });
  }

  spawn(cmd: string, args: string[], opts: SandboxSpawnOptions = {}): SandboxProcess {
    const cwd = this.#resolveCwd(opts);
    const env = this.#buildEnv(opts);
    const child = nodeSpawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    return wrapNodeProcess(child);
  }

  async dispose(): Promise<void> {
    if (this.#ownsWorkdir && this.#workdir) {
      await rm(this.#workdir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.#workdir = null;
  }

  #resolveCwd(opts: SandboxSpawnOptions): string {
    const base = this.workdir();
    if (!opts.cwd) return base;
    return isAbsolute(opts.cwd) ? opts.cwd : join(base, opts.cwd);
  }

  /**
   * Inherit the host env (PATH, HOME, codex auth) and overlay the sandbox base
   * env + per-call env. NO_PROXY is forced because the macOS proxy hijacks
   * localhost, which breaks codex's localhost transport.
   */
  #buildEnv(opts: SandboxSpawnOptions): Record<string, string> {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    return {
      ...inherited,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      ...this.#baseEnv,
      ...(opts.env ?? {}),
    };
  }
}
