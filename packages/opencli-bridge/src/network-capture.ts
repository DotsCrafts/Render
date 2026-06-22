/**
 * Per-lease network capture — mirrors the extension's `network-capture-start` /
 * `network-capture-read` (decoded from `background.js` lines 453-578).
 *
 * The extension enables the CDP Network domain and buffers
 * `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` into a
 * per-tab ring. `read` returns the buffered entries and DRAINS them (the read is
 * incremental/destructive). We reproduce that exactly, but keyed per LEASE (each
 * lease is its own CDP target, so isolation is structural — capturing on one
 * lease never sees another lease's traffic).
 *
 * Each captured entry matches the extension's wire shape so opencli's
 * `network-cache`/`network-key` consumers map it unchanged.
 */

import type { CdpTarget } from './types.js';

/** Substring patterns are `|`-split; empty captures everything (extension parity). */
const normalizePatterns = (pattern: string | undefined): string[] =>
  (pattern ?? '')
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);

const shouldCapture = (url: string, patterns: string[]): boolean =>
  patterns.length === 0 || patterns.some((p) => url.includes(p));

const normalizeHeaders = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : String(v);
    }
  }
  return out;
};

/** The extension's captured-entry shape (the load-bearing wire contract). */
export interface CaptureEntry {
  kind: 'cdp';
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  timestamp: number;
  responseStatus?: number;
  responseContentType?: string;
  responseHeaders?: Record<string, string>;
}

interface CaptureState {
  patterns: string[];
  entries: CaptureEntry[];
  /** CDP requestId → index in `entries`, so response events update the request. */
  requestToIndex: Map<string, number>;
  unsubscribe: () => void;
}

/** Wired CDP event params we read (loosely typed — CDP adds fields freely). */
interface RequestWillBeSent {
  requestId: string;
  request?: { url?: string; method?: string; headers?: Record<string, string> };
}
interface ResponseReceived {
  requestId: string;
  response?: { status?: number; mimeType?: string; headers?: Record<string, string> };
}

/**
 * Holds capture state per CdpTarget. The provider owns the targets; this map's
 * keys are the stable targetIds, so capture is isolated per lease and torn down
 * when the lease's target id disappears (we clean up lazily on read/start).
 */
export interface NetworkCaptureRegistry {
  start(target: CdpTarget, pattern?: string): Promise<void>;
  /** Return buffered entries and DRAIN (extension `readNetworkCapture` semantics). */
  read(target: CdpTarget): CaptureEntry[];
  /** Whether a target currently has an active capture (navigate keeps it alive). */
  isActive(target: CdpTarget): boolean;
  /** Stop + forget all captures (used on provider dispose). */
  clear(): void;
}

export function createNetworkCaptureRegistry(): NetworkCaptureRegistry {
  const states = new Map<string, CaptureState>();

  const start = async (target: CdpTarget, pattern?: string): Promise<void> => {
    // Re-starting on a live capture resets the buffer + patterns (extension parity).
    const prior = states.get(target.targetId);
    if (prior) prior.unsubscribe();

    await target.send('Network.enable', {});

    const state: CaptureState = {
      patterns: normalizePatterns(pattern),
      entries: [],
      requestToIndex: new Map(),
      unsubscribe: () => {},
    };

    const onRequest = (params: unknown): void => {
      const p = params as RequestWillBeSent;
      const url = p.request?.url ?? '';
      if (!shouldCapture(url, state.patterns)) return;
      const entry: CaptureEntry = {
        kind: 'cdp',
        url,
        method: p.request?.method ?? 'GET',
        requestHeaders: normalizeHeaders(p.request?.headers),
        timestamp: Date.now(),
      };
      state.requestToIndex.set(p.requestId, state.entries.length);
      state.entries.push(entry);
    };

    const onResponse = (params: unknown): void => {
      const p = params as ResponseReceived;
      const idx = state.requestToIndex.get(p.requestId);
      if (idx === undefined) return;
      const entry = state.entries[idx];
      if (!entry) return;
      if (typeof p.response?.status === 'number') entry.responseStatus = p.response.status;
      if (typeof p.response?.mimeType === 'string') entry.responseContentType = p.response.mimeType;
      if (p.response?.headers) entry.responseHeaders = normalizeHeaders(p.response.headers);
    };

    const offReq = target.on('Network.requestWillBeSent', onRequest);
    const offResp = target.on('Network.responseReceived', onResponse);
    state.unsubscribe = () => {
      offReq();
      offResp();
    };
    states.set(target.targetId, state);
  };

  const read = (target: CdpTarget): CaptureEntry[] => {
    const state = states.get(target.targetId);
    if (!state) return [];
    const drained = state.entries.slice();
    state.entries = [];
    state.requestToIndex.clear();
    return drained;
  };

  const isActive = (target: CdpTarget): boolean => states.has(target.targetId);

  const clear = (): void => {
    for (const state of states.values()) state.unsubscribe();
    states.clear();
  };

  return { start, read, isActive, clear };
}
