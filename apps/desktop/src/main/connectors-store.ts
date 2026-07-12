/**
 * connectors-store — last-known login state per opencli site, persisted under
 * `userData/connectors.json` so the Connectors page paints instantly on boot
 * (mirrors pages-store's userData JSON pattern).
 *
 * Only STABLE statuses are stored (connected / disconnected / unknown) — the
 * transient ones (checking / connecting) are runtime-only. The cache is a hint,
 * never a verdict: the ConnectorService re-probes stale entries lazily.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A persisted last-known state for one site. */
export interface StoredConnector {
  status: 'connected' | 'disconnected' | 'unknown';
  account?: string;
  lastChecked?: number;
  detail?: string;
}

export interface ConnectorsStore {
  load(): Record<string, StoredConnector>;
  save(sites: Record<string, StoredConnector>): void;
}

const STORED_STATUSES = new Set(['connected', 'disconnected', 'unknown']);

/**
 * Same slug shape ConnectorService enforces on its IPC surface. Enforced on
 * LOAD too: stored-only sites are auto-probed on refresh, so a tampered
 * connectors.json must not be able to smuggle a flag-like key ("--profile")
 * into the opencli argv.
 */
const SITE_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

function toStored(raw: unknown): StoredConnector | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== 'string' || !STORED_STATUSES.has(r.status)) return undefined;
  return {
    status: r.status as StoredConnector['status'],
    ...(typeof r.account === 'string' ? { account: r.account } : {}),
    ...(typeof r.lastChecked === 'number' ? { lastChecked: r.lastChecked } : {}),
    ...(typeof r.detail === 'string' ? { detail: r.detail } : {}),
  };
}

export function createConnectorsStore(opts: { userDataDir: string }): ConnectorsStore {
  const file = join(opts.userDataDir, 'connectors.json');

  const load = (): Record<string, StoredConnector> => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        version?: unknown;
        sites?: unknown;
      };
      if (raw?.version !== 1 || raw.sites == null || typeof raw.sites !== 'object') return {};
      const out: Record<string, StoredConnector> = {};
      for (const [site, rec] of Object.entries(raw.sites as Record<string, unknown>)) {
        if (!SITE_KEY_RE.test(site)) continue;
        const stored = toStored(rec);
        if (stored) out[site] = stored;
      }
      return out;
    } catch {
      return {}; // missing / corrupt cache is not an error — probes rebuild it
    }
  };

  const save = (sites: Record<string, StoredConnector>): void => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 1, sites }, null, 2));
    } catch (err) {
      console.warn('[connectors-store] persist failed:', String(err));
    }
  };

  return { load, save };
}
