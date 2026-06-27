/**
 * Turn the agent's final answer into a structured `ux render` message so it
 * displays as a json-render card (RenderSurface) instead of plain feed text.
 *
 * The agent is instructed (AGENTS.md) to end its turn with a fenced ```render
 * block of UxRenderSpec JSON. We extract & validate it; if it's absent or
 * malformed, we gracefully wrap the prose as the card `body` so the user ALWAYS
 * gets a card, never raw text in the feed.
 */
import type {
  UxBlockOption,
  UxBlockSpec,
  UxMessage,
  UxRenderSpec,
  UxRenderItem,
} from '@render/protocol';

const FENCE = /```(?:render|json)?\s*\n([\s\S]*?)```/gi;
// A ```block fence lets the agent raise a block-decision card (Delta 1): a
// question + optional choices + an inline free-text steer field. Scanned BEFORE
// the render fence so a turn that needs a decision surfaces as a `block`, not a
// terminal `render` card.
const BLOCK_FENCE = /```block\s*\n([\s\S]*?)```/gi;

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

/** Find the last ```block that parses into a {question}-shaped block spec. */
export function extractBlockSpec(text: string): UxBlockSpec | null {
  const blocks: string[] = [];
  for (const m of text.matchAll(BLOCK_FENCE)) if (m[1]) blocks.push(m[1]);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const spec = coerceBlockSpec(blocks[i]);
    if (spec) return spec;
  }
  return null;
}

function coerceBlockSpec(raw: string): UxBlockSpec | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.question !== 'string' || !o.question.trim()) return null;
  const spec: UxBlockSpec = { question: o.question };
  if (Array.isArray(o.options)) {
    const options = o.options.map(coerceBlockOption).filter(Boolean) as UxBlockOption[];
    if (options.length) spec.options = options;
  }
  if (typeof o.allowInstruction === 'boolean') spec.allowInstruction = o.allowInstruction;
  if (typeof o.instructionLabel === 'string') spec.instructionLabel = o.instructionLabel;
  if (typeof o.instructionPlaceholder === 'string')
    spec.instructionPlaceholder = o.instructionPlaceholder;
  if (typeof o.submitLabel === 'string') spec.submitLabel = o.submitLabel;
  if (typeof o.danger === 'boolean') spec.danger = o.danger;
  return spec;
}

function coerceBlockOption(v: unknown): UxBlockOption | null {
  if (typeof v === 'string') return v.trim() ? { label: v } : null;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.label !== 'string' || !o.label.trim()) return null;
  const opt: UxBlockOption = { label: o.label };
  if (typeof o.meta === 'string' && o.meta.trim()) opt.meta = o.meta;
  return opt;
}

/**
 * Build the ux message for an agent answer. A ```block fence becomes a
 * (non-blocking) block-decision card — the agent is asking the human to steer;
 * otherwise the answer becomes a `render` card (parsed spec or prose fallback).
 */
export function answerToUxMessage(text: string, id: string, ts: number): UxMessage {
  const block = extractBlockSpec(text);
  if (block) {
    return { id, kind: 'block', blocking: false, ts, spec: block };
  }
  const parsed = extractRenderSpec(text);
  const spec: UxRenderSpec = parsed ?? { body: stripFences(text) || text.trim() };
  return { id, kind: 'render', blocking: false, ts, spec };
}
