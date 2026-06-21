/**
 * Internal types for the opencli app-hand router.
 *
 * The public surface is the protocol `OpencliRouter`; these are the
 * implementation seams (deps the desktop main / smoke script inject, and the
 * shape of opencli's own `list -f json` metadata that drives classification).
 */

import type { AdapterStrategy, SandboxProvider } from '@render/protocol';

/** Minimal slice of the human-hand the router needs (the CDP relay endpoint). */
export interface CdpEndpointSource {
  /** ws://127.0.0.1:<port> relay a remote opencli targets (client-pull). */
  cdpEndpoint(): Promise<string>;
}

export interface OpencliRouterDeps {
  /**
   * Where API/public adapters run (credential-blind). Provided by @render/sandbox.
   * `start()` is called lazily if the caller hasn't already.
   */
  sandbox: SandboxProvider;
  /**
   * The human-hand whose `cdpEndpoint()` browser/cookie adapters are pointed at
   * via OPENCLI_CDP_ENDPOINT. Optional: without it, browser adapters resolve to
   * `needsLogin` instead of running.
   */
  humanHand?: CdpEndpointSource;
  /** opencli executable name/path (default "opencli"). */
  opencliBin?: string;
  /**
   * Offline classification fallback for well-known sites when `opencli list`
   * metadata lacks the command. Keyed by site (applies to all its commands).
   */
  fallback?: Record<string, AdapterStrategy>;
}

/** One opencli command as reported by `opencli list -f json`. */
export interface ArgMeta {
  name: string;
  type: string;
  required: boolean;
  positional: boolean;
}

export interface CommandMeta {
  command: string; // "arxiv/search"
  site: string; // "arxiv"
  name: string; // "search"
  /** opencli's own strategy taxonomy: public | cookie | ui | intercept | local */
  rawStrategy: string;
  browser: boolean;
  access: string; // "read" | "write"
  args: ArgMeta[];
  domain?: string;
}

/** Raw stdout/stderr/exit from one opencli run. */
export interface OpencliExec {
  exitCode: number;
  stdout: string;
  stderr: string;
}
