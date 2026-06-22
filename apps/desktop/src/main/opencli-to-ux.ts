/**
 * Map an OpencliResult (the app hand's real output) into the UxMessage the agent
 * panel renders:
 *
 *   needsLogin → ux login   (drive the human-hand login tab, then retry)
 *   ok + data  → ux render   (real adapter rows as cards)
 *   error      → ux render   (failure surfaced as prose, non-blocking)
 *
 * Pure: returns a fresh UxMessage built only from whitelisted spec fields.
 */

import type {
  OpencliInvocation,
  OpencliResult,
  UxMessage,
  UxRenderItem,
} from '@render/protocol';

const MAX_ITEMS = 6;
const MAX_FIELDS = 4;

export function opencliResultToUx(
  res: OpencliResult,
  inv: OpencliInvocation,
  id: string,
  ts: number,
): UxMessage {
  const label = `${inv.site} ${inv.command}`;

  if (res.needsLogin) {
    return {
      id,
      kind: 'login',
      blocking: true,
      ts,
      spec: {
        site: res.needsLogin.site,
        reason: `opencli ${label} needs a logged-in ${res.needsLogin.site} session`,
        loginUrl: res.needsLogin.loginUrl,
      },
    };
  }

  if (!res.ok) {
    return {
      id,
      kind: 'render',
      blocking: false,
      ts,
      spec: {
        title: `opencli ${label} failed`,
        body: res.error ?? 'opencli returned a non-zero exit with no detail',
      },
    };
  }

  const items = toItems(res.data);
  return {
    id,
    kind: 'render',
    blocking: false,
    ts,
    spec: {
      title: `${label} · ${res.ranOn}`,
      body: `${items.length} result${items.length === 1 ? '' : 's'} from the ${res.strategy} adapter`,
      items,
    },
  };
}

function toItems(data: unknown): UxRenderItem[] {
  const rows = Array.isArray(data) ? data : data == null ? [] : [data];
  return rows.slice(0, MAX_ITEMS).map((row) => toItem(row));
}

function toItem(row: unknown): UxRenderItem {
  if (row == null || typeof row !== 'object') {
    return { title: String(row) };
  }
  const obj = row as Record<string, unknown>;
  const title = pick(obj, ['title', 'name', 'headline', 'id']);
  const subtitle = pick(obj, ['summary', 'subtitle', 'published', 'description', 'author']);
  const url = pick(obj, ['url', 'link', 'href']);

  const used = new Set(['title', 'name', 'headline', 'id', 'summary', 'subtitle', 'published', 'description', 'author', 'url', 'link', 'href']);
  const fields: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (used.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number') {
      fields[k] = typeof v === 'string' ? v.slice(0, 120) : v;
      if (Object.keys(fields).length >= MAX_FIELDS) break;
    }
  }

  return {
    ...(title ? { title: title.slice(0, 160) } : {}),
    ...(subtitle ? { subtitle: subtitle.slice(0, 200) } : {}),
    ...(url ? { url } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
  };
}

function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}
