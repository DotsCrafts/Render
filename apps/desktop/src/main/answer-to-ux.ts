/**
 * Turn the agent's final answer into a structured `ux render` message so it
 * displays as a json-render card (RenderSurface) instead of plain feed text.
 *
 * The agent is instructed (AGENTS.md) to end its turn with a fenced ```render
 * block of UxRenderSpec JSON. We extract & validate it; if it's absent or
 * malformed, we gracefully wrap the prose as the card `body` so the user ALWAYS
 * gets a card, never raw text in the feed.
 */
import type { UxMessage, UxRenderSpec, UxRenderItem } from '@render/protocol';

const FENCE = /```(?:render|json)?\s*\n([\s\S]*?)```/gi;

/** Find the last ```render / ```json block that parses into a render-shaped object. */
export function extractRenderSpec(text: string): UxRenderSpec | null {
  const blocks: string[] = [];
  for (const m of text.matchAll(FENCE)) if (m[1]) blocks.push(m[1]);
  // also accept a whole-message bare JSON object
  if (blocks.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) blocks.push(trimmed);
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const spec = coerceRenderSpec(blocks[i]);
    if (spec) return spec;
  }
  return null;
}

function coerceRenderSpec(raw: string): UxRenderSpec | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  // Full @json-render Spec → dynamic UI passthrough. Carry a plain-text fallback
  // (harvested from the spec's Text/Heading nodes) for the render-error path.
  if (typeof o.root === 'string' && o.elements && typeof o.elements === 'object') {
    return { ui: o, body: harvestText(o.elements as Record<string, unknown>) };
  }
  const hasShape =
    typeof o.title === 'string' || typeof o.body === 'string' || Array.isArray(o.items);
  if (!hasShape) return null;
  const spec: UxRenderSpec = {};
  if (typeof o.title === 'string') spec.title = o.title;
  if (typeof o.body === 'string') spec.body = o.body;
  if (Array.isArray(o.items)) spec.items = o.items.map(coerceItem).filter(Boolean) as UxRenderItem[];
  return spec;
}

function coerceItem(v: unknown): UxRenderItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const item: UxRenderItem = {};
  if (typeof o.title === 'string') item.title = o.title;
  if (typeof o.subtitle === 'string') item.subtitle = o.subtitle;
  if (typeof o.image === 'string') item.image = o.image;
  if (typeof o.url === 'string') item.url = o.url;
  if (o.fields && typeof o.fields === 'object') {
    const fields: Record<string, string | number> = {};
    for (const [k, val] of Object.entries(o.fields as Record<string, unknown>)) {
      if (typeof val === 'string' || typeof val === 'number') fields[k] = val;
    }
    if (Object.keys(fields).length) item.fields = fields;
  }
  return Object.keys(item).length ? item : null;
}

/** Collect visible text from a json-render elements map (Text/Heading props.text). */
function harvestText(elements: Record<string, unknown>): string {
  const out: string[] = [];
  for (const el of Object.values(elements)) {
    if (el && typeof el === 'object') {
      const props = (el as Record<string, unknown>).props as Record<string, unknown> | undefined;
      const t = props?.text;
      if (typeof t === 'string' && t.trim()) out.push(t.trim());
    }
  }
  return out.join('\n').slice(0, 600);
}

/** Strip fenced render/json blocks, leaving readable prose for the fallback body. */
function stripFences(text: string): string {
  return text.replace(FENCE, '').trim();
}

/** Build the ux render message for an agent answer (parsed spec or prose fallback). */
export function answerToUxMessage(text: string, id: string, ts: number): UxMessage {
  const parsed = extractRenderSpec(text);
  const spec: UxRenderSpec = parsed ?? { body: stripFences(text) || text.trim() };
  return { id, kind: 'render', blocking: false, ts, spec };
}
