/**
 * @render/opencli-router — the APP HAND.
 *
 * Implements the protocol `OpencliRouter`: classify adapters from real opencli
 * metadata, run public/API adapters in @render/sandbox, and route browser/cookie
 * adapters to the real logged-in Chromium via the cdp-human-hand relay.
 */

export { createOpencliRouter } from './router.js';
export type { OpencliRouterHandle } from './router.js';
export { MetadataIndex, mapStrategy } from './metadata.js';
export {
  extractJson,
  isAuthRequired,
  isBrowserUnavailable,
  extractLoginUrl,
  AUTH_REQUIRED_EXIT,
  BROWSER_CONNECT_EXIT,
} from './parse.js';
export { buildArgv } from './argv.js';
export type {
  OpencliRouterDeps,
  CdpEndpointSource,
  CommandMeta,
  ArgMeta,
  OpencliExec,
} from './types.js';

// Re-export the contract types for convenience.
export type {
  OpencliRouter,
  OpencliInvocation,
  OpencliResult,
  AdapterStrategy,
} from '@render/protocol';
