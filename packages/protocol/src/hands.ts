/**
 * The three "hands" contracts (per Anthropic's managed-agents framing).
 * Brain = codex (see codex.ts). These interfaces are the seams the desktop
 * main process wires together; each `packages/*` implements one.
 *
 *   app hand    → opencli adapters  (OpencliRouter)
 *   sandbox hand→ e2b / local       (SandboxProvider)
 *   human hand  → chromium CDP      (HumanHand)
 */

// ── Sandbox hand ─────────────────────────────────────────────────────────────

export interface SandboxSpawnOptions {
  /** working dir inside the sandbox; agent + opencli run here */
  cwd?: string;
  /** env injected into the sandbox — NEVER web/site credentials (Plane 2) */
  env?: Record<string, string>;
  /**
   * exec-only deadline: kill the child on expiry and resolve with a synthetic
   * non-zero ExecResult (exit 124, stderr notes the timeout). Unset = unbounded.
   */
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A SandboxProvider is where the BRAIN and the API/app opencli adapters run.
 * Two impls behind one seam:
 *   - 'local-seatbelt' (default, keyless, runs today via codex's own OS sandbox)
 *   - 'e2b'            (cross-end, active when E2B_API_KEY is present)
 */
export interface SandboxProvider {
  readonly id: 'local-seatbelt' | 'e2b' | (string & {});
  start(opts?: SandboxSpawnOptions): Promise<void>;
  /** run a one-shot command inside the sandbox */
  exec(cmd: string, args: string[], opts?: SandboxSpawnOptions): Promise<ExecResult>;
  /** spawn a long-lived process (e.g. codex app-server) — returns stdio streams */
  spawn(cmd: string, args: string[], opts?: SandboxSpawnOptions): SandboxProcess;
  /** absolute path mapping for the agent's workspace */
  workdir(): string;
  dispose(): Promise<void>;
}

export interface SandboxProcess {
  readonly pid: number | string;
  write(data: string): void;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

// ── App hand (opencli router) ────────────────────────────────────────────────

export type AdapterStrategy = 'public' | 'cookie' | 'browser';

export interface OpencliInvocation {
  site: string; // "google", "zhihu", "dianping", "ux", ...
  command: string; // "search", "hot", "login", ...
  args?: Record<string, string | number | boolean>;
  format?: 'json' | 'table' | 'yaml' | 'md' | 'csv';
}

export interface OpencliResult {
  ok: boolean;
  strategy: AdapterStrategy;
  /** where it actually ran */
  ranOn: 'sandbox' | 'cdp-human-hand';
  data?: unknown;
  raw?: string;
  error?: string;
  /** set when a browser adapter needs a logged-in session first */
  needsLogin?: { site: string; loginUrl?: string };
}

/**
 * Routes an opencli invocation to the right hand:
 *   public/API adapters → SandboxProvider (headless ok)
 *   browser adapters    → HumanHand CDP plane (real logged-in Chromium)
 */
export interface OpencliRouter {
  classify(site: string, command: string): Promise<AdapterStrategy>;
  invoke(inv: OpencliInvocation): Promise<OpencliResult>;
  /**
   * Drive `opencli <site> login` over the human-hand; resolves when logged in.
   * Unbounded by default (a human is typing); pass `timeoutMs` to cap a
   * background login journey — expiry kills the CLI and resolves loggedIn:false.
   */
  login(site: string, opts?: { timeoutMs?: number }): Promise<{ loggedIn: boolean; account?: string }>;
}

// ── Human hand (chromium CDP) ────────────────────────────────────────────────

/**
 * Controls the in-process Chromium tabs via CDP (webContents.debugger '1.3').
 * Holds Plane-2 (web/site) auth in the browser profile. Also exposes a local
 * CDP relay endpoint (reverse-proxy seam) so a REMOTE sandbox (e2b) can reach
 * this browser via OPENCLI_CDP_ENDPOINT following the client-pull iron law.
 */
export interface HumanHand {
  /** attach CDP to a tab's webContents; idempotent */
  attach(tabId: string): Promise<void>;
  /** raw CDP command on the active/attached tab */
  send<T = unknown>(tabId: string, method: string, params?: object): Promise<T>;
  navigate(tabId: string, url: string): Promise<void>;
  /** open a visible tab dedicated to a human login journey */
  openLoginTab(site: string, url?: string): Promise<string>;
  /**
   * Local CDP endpoint a remote sandbox can target. For the local prototype the
   * relay points straight at the in-process Chromium; for e2b it is tunneled
   * (client-pull). Returns e.g. "ws://127.0.0.1:<port>" or a tunnel URL.
   */
  cdpEndpoint(): Promise<string>;
}
