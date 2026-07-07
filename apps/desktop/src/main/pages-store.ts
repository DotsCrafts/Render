/**
 * pages-store — Delta 3 spec persistence + the Saved-Pages vault.
 *
 * A Tier-2 page is PURE given its json-render spec + the server-owned allowlist:
 * re-serving the spec reproduces the page (data is refetched live via /ux/data).
 * So we persist the SPEC, not a rendered snapshot. Each page is a directory under
 * `userData/pages/<id>/` holding versioned `v<n>.json` records; the newest version
 * is the live one. "Reopen" just re-runs serveUxSpec from the saved spec.
 *
 * Every page the agent delivers is persisted immediately as a DRAFT (saved:false)
 * so it can be reopened within the session; the human's explicit "Save" flips it
 * to saved:true, which is what the gallery (listPages) shows.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SavedPageMeta, SavedPageRecord } from '@render/protocol';
import { serveUxSpec, type UxPage } from './ux-server.js';

export interface PagesStore {
  /** Persist a freshly-served page spec as a draft; returns its new id. */
  persist(input: {
    specJson: string;
    title: string;
    allow: string;
    allowWrite?: string;
    convId?: string;
  }): string;
  /** Flip a page to saved:true (shows in the gallery). Returns its meta or null. */
  save(id: string): SavedPageMeta | null;
  /** Append a new version of an existing page (Delta 5 regeneration). */
  addVersion(
    id: string,
    input: { specJson: string; title?: string; allow?: string; allowWrite?: string },
  ): SavedPageMeta | null;
  /** The saved pages (saved:true), newest-first — the gallery's data. */
  list(): SavedPageMeta[];
  /** The newest version record for a page, or null. */
  get(id: string): SavedPageRecord | null;
  /**
   * Re-serve a page's newest spec via the ux-server and return the UxPage. The
   * store retains NO server handles — the CALLER owns disposal (the IPC broker
   * registers reopened pages, deduped per id, and reaps them on tab close /
   * window close). Async: it re-serves through the runtime's `serve` hook (write
   * broker + callback forwarding), which awaits the confirm-broker endpoint.
   */
  reopen(id: string): Promise<UxPage | null>;
}

interface StoreOpts {
  /** base dir, typically app.getPath('userData') */
  userDataDir: string;
  /** OPENCLI_PROFILE the re-served ux server runs under (Render's bridge profile) */
  profile?: string;
  /**
   * Serve a page with the runtime's full write-path wiring (spec-guard, write
   * confirm broker, callback→conversation forwarding). Wired by index.ts to
   * agent.servePage so reopened pages round-trip exactly like fresh ones. When
   * absent, reopen falls back to a bare serveUxSpec — pages still render, page
   * actions go nowhere, and the kernel fail-closes all writes (no broker).
   */
  serve?: (input: {
    specJson: string;
    title?: string;
    allow?: string;
    allowWrite?: string;
  }) => Promise<UxPage>;
  now: () => number;
}

function safeId(now: () => number, seq: () => number): string {
  return `pg-${now().toString(36)}-${seq().toString(36)}`;
}

export function createPagesStore(opts: StoreOpts): PagesStore {
  const root = join(opts.userDataDir, 'pages');
  let seq = 0;
  const nextSeq = () => ++seq;

  const ensureRoot = (): void => {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
  };
  const pageDir = (id: string): string => join(root, id);

  const versionsOf = (id: string): number[] => {
    const dir = pageDir(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => /^v(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  };

  const readRecord = (id: string, version: number): SavedPageRecord | null => {
    try {
      const raw = readFileSync(join(pageDir(id), `v${version}.json`), 'utf8');
      const rec = JSON.parse(raw) as SavedPageRecord;
      return rec && typeof rec.specJson === 'string' ? rec : null;
    } catch {
      return null;
    }
  };

  const writeRecord = (rec: SavedPageRecord): void => {
    const dir = pageDir(rec.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `v${rec.version}.json`), JSON.stringify(rec, null, 2));
  };

  const toMeta = (rec: SavedPageRecord): SavedPageMeta => ({
    id: rec.id,
    title: rec.title,
    saved: rec.saved,
    version: rec.version,
    savedAt: rec.savedAt,
    allow: rec.allow,
    ...(rec.allowWrite ? { allowWrite: rec.allowWrite } : {}),
    ...(rec.convId ? { convId: rec.convId } : {}),
  });

  const get = (id: string): SavedPageRecord | null => {
    const vs = versionsOf(id);
    if (!vs.length) return null;
    return readRecord(id, vs[vs.length - 1]);
  };

  const persist: PagesStore['persist'] = (input) => {
    ensureRoot();
    const id = safeId(opts.now, nextSeq);
    writeRecord({
      id,
      title: input.title,
      specJson: input.specJson,
      allow: input.allow,
      ...(input.allowWrite ? { allowWrite: input.allowWrite } : {}),
      ...(input.convId ? { convId: input.convId } : {}),
      version: 1,
      savedAt: opts.now(),
      saved: false,
    });
    return id;
  };

  const save: PagesStore['save'] = (id) => {
    const rec = get(id);
    if (!rec) return null;
    const next: SavedPageRecord = { ...rec, saved: true, savedAt: opts.now() };
    writeRecord(next); // same version, flipped to saved
    return toMeta(next);
  };

  const addVersion: PagesStore['addVersion'] = (id, input) => {
    const rec = get(id);
    if (!rec) return null;
    const next: SavedPageRecord = {
      ...rec,
      specJson: input.specJson,
      ...(input.title ? { title: input.title } : {}),
      ...(input.allow !== undefined ? { allow: input.allow } : {}),
      ...(input.allowWrite !== undefined ? { allowWrite: input.allowWrite } : {}),
      version: rec.version + 1,
      savedAt: opts.now(),
    };
    writeRecord(next);
    return toMeta(next);
  };

  const list: PagesStore['list'] = () => {
    ensureRoot();
    const ids = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    return ids
      .map(get)
      .filter((r): r is SavedPageRecord => !!r && r.saved)
      .sort((a, b) => b.savedAt - a.savedAt)
      .map(toMeta);
  };

  const reopen: PagesStore['reopen'] = async (id) => {
    const rec = get(id);
    if (!rec) return null;
    // Prefer the runtime-wired serve (write broker + callback forwarding) so a
    // reopened page behaves exactly like a freshly delivered one.
    if (opts.serve) {
      try {
        return await opts.serve({
          specJson: rec.specJson,
          title: rec.title,
          allow: rec.allow,
          ...(rec.allowWrite ? { allowWrite: rec.allowWrite } : {}),
        });
      } catch (err) {
        console.warn('[pages-store] runtime serve rejected the saved spec:', String(err));
        return null;
      }
    }
    return serveUxSpec({
      specJson: rec.specJson,
      allow: rec.allow,
      ...(rec.allowWrite ? { allowWrite: rec.allowWrite } : {}),
      idTag: `reopen-${id}-${opts.now()}`,
      ...(opts.profile ? { profile: opts.profile } : {}),
    });
  };

  return { persist, save, addVersion, list, get, reopen };
}
