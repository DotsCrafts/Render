/**
 * e2b SandboxProvider — the cross-end sandbox hand.
 *
 * Same `SandboxProvider` seam as local-seatbelt, backed by a remote e2b sandbox
 * (https://e2b.dev). Activated when `E2B_API_KEY` is present. The e2b SDK is an
 * optional dependency: the value is dynamically imported so a build without the
 * SDK (or without a key) still loads — `selectSandbox()` falls back to local.
 *
 * The e2b runtime gives real isolation for free, so there is no seatbelt layer
 * here; the whole sandbox IS the jail. As with local, Plane-2 web credentials
 * are never injected.
 */

import type { CommandHandle, Sandbox } from 'e2b';
import type {
  ExecResult,
  SandboxProcess,
  SandboxProvider,
  SandboxSpawnOptions,
} from '@render/protocol';

export interface E2bOptions {
  apiKey?: string;
  /** e2b template to boot (must contain codex-cli to run the BRAIN) */
  template?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** POSIX single-quote a token so cmd+args can be sent as one shell string. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const toCommand = (cmd: string, args: string[]): string =>
  [cmd, ...args].map(shQuote).join(' ');

export class E2bSandbox implements SandboxProvider {
  readonly id = 'e2b' as const;

  #sandbox: Sandbox | null = null;
  readonly #opts: E2bOptions;
  #cwd = '/home/user';

  constructor(opts: E2bOptions = {}) {
    this.#opts = opts;
  }

  async start(opts: SandboxSpawnOptions = {}): Promise<void> {
    const { Sandbox } = (await import('e2b')) as typeof import('e2b');
    const envs = { ...this.#opts.env, ...opts.env };
    const create = this.#opts.template
      ? Sandbox.create(this.#opts.template, {
          apiKey: this.#opts.apiKey,
          timeoutMs: this.#opts.timeoutMs,
          envs,
        })
      : Sandbox.create({ apiKey: this.#opts.apiKey, timeoutMs: this.#opts.timeoutMs, envs });
    this.#sandbox = await create;
    if (opts.cwd) {
      this.#cwd = opts.cwd;
      await this.#sandbox.files.makeDir(opts.cwd).catch(() => undefined);
    }
  }

  workdir(): string {
    return this.#cwd;
  }

  async exec(cmd: string, args: string[], opts: SandboxSpawnOptions = {}): Promise<ExecResult> {
    const sandbox = this.#require();
    const command = toCommand(cmd, args);
    const runOpts = { cwd: opts.cwd ?? this.#cwd, envs: opts.env };
    try {
      const r = await sandbox.commands.run(command, { ...runOpts, background: false });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      // e2b throws CommandExitError on non-zero exit; it carries the result.
      const err = e as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
      if (typeof err.exitCode === 'number') {
        return { exitCode: err.exitCode, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
      }
      throw new Error(`e2b exec failed: ${err.message ?? String(e)}`);
    }
  }

  spawn(cmd: string, args: string[], opts: SandboxSpawnOptions = {}): SandboxProcess {
    const sandbox = this.#require();
    const command = toCommand(cmd, args);
    return new E2bProcess(sandbox, command, {
      cwd: opts.cwd ?? this.#cwd,
      envs: opts.env,
    });
  }

  async dispose(): Promise<void> {
    if (this.#sandbox) {
      await this.#sandbox.kill().catch(() => undefined);
      this.#sandbox = null;
    }
  }

  #require(): Sandbox {
    if (!this.#sandbox) throw new Error('E2bSandbox: start() not called');
    return this.#sandbox;
  }
}

/**
 * Facade that satisfies the synchronous `SandboxProcess` contract over e2b's
 * async background command. Listeners registered before the handle resolves are
 * buffered and replayed; stdin written early is queued and flushed on ready.
 */
class E2bProcess implements SandboxProcess {
  #handle: CommandHandle | null = null;
  #pid: number | string = -1;
  #stdoutCbs: Array<(c: string) => void> = [];
  #stderrCbs: Array<(c: string) => void> = [];
  #exitCbs: Array<(code: number | null) => void> = [];
  #stdinQueue: string[] = [];
  #killed = false;

  constructor(
    sandbox: Sandbox,
    command: string,
    runOpts: { cwd?: string; envs?: Record<string, string> },
  ) {
    void this.#launch(sandbox, command, runOpts);
  }

  async #launch(
    sandbox: Sandbox,
    command: string,
    runOpts: { cwd?: string; envs?: Record<string, string> },
  ): Promise<void> {
    try {
      const handle = await sandbox.commands.run(command, {
        ...runOpts,
        background: true,
        onStdout: (d: string) => this.#stdoutCbs.forEach((cb) => cb(d)),
        onStderr: (d: string) => this.#stderrCbs.forEach((cb) => cb(d)),
      });
      this.#handle = handle;
      this.#pid = handle.pid;
      if (this.#killed) {
        await handle.kill().catch(() => undefined);
        return;
      }
      for (const data of this.#stdinQueue) await handle.sendStdin(data).catch(() => undefined);
      this.#stdinQueue = [];
      handle
        .wait()
        .then((r) => this.#exitCbs.forEach((cb) => cb(r.exitCode ?? null)))
        .catch((e: { exitCode?: number }) =>
          this.#exitCbs.forEach((cb) => cb(typeof e?.exitCode === 'number' ? e.exitCode : null)),
        );
    } catch {
      this.#exitCbs.forEach((cb) => cb(null));
    }
  }

  get pid() {
    return this.#pid;
  }

  write(data: string): void {
    if (this.#handle) void this.#handle.sendStdin(data).catch(() => undefined);
    else this.#stdinQueue.push(data);
  }

  onStdout(cb: (chunk: string) => void): void {
    this.#stdoutCbs.push(cb);
  }

  onStderr(cb: (chunk: string) => void): void {
    this.#stderrCbs.push(cb);
  }

  onExit(cb: (code: number | null) => void): void {
    this.#exitCbs.push(cb);
  }

  kill(): void {
    this.#killed = true;
    if (this.#handle) void this.#handle.kill().catch(() => undefined);
  }
}
