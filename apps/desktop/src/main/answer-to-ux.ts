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

const FENCE = /```(render|json)?\s*\n([\s\S]*?)```/gi;
// A ```block fence lets the agent raise a block-decision card (Delta 1): a
// question + optional choices + an inline free-text steer field. Scanned BEFORE
// the render fence so a turn that needs a decision surfaces as a `block`, not a
// terminal `render` card.
const BLOCK_FENCE = /```block\s*\n([\s\S]*?)```/gi;

interface ExtractedSpec {
  spec: UxRenderSpec;
  /** the exact source text (full fence / bare object) the spec was parsed from */
  consumed: string;
}

/**
 * Find the last fenced block that parses into a render spec. A ```render fence
 * is always a spec candidate (the LENIENT simple shape is allowed). A ```json
 * or untagged fence is only treated as a MISLABELED spec when the fence is
 * essentially the whole message — a json blob quoted inside a prose answer must
 * stay prose (and is NOT deleted: only the consumed source is stripped from the
 * fallback body). The strict json-render shape ({root, elements}) is accepted
 * from any fence.
 */
export function extractAnswerSpec(text: string): ExtractedSpec | null {
  const surroundingProse = text.replace(FENCE, '').trim();
  const candidates: Array<{ raw: string; consumed: string; lenient: boolean }> = [];
  for (const m of text.matchAll(FENCE)) {
    if (!m[2]) continue;
    const tag = (m[1] ?? '').toLowerCase();
    candidates.push({
      raw: m[2],
      consumed: m[0],
      lenient: tag === 'render' || surroundingProse.length < 40,
    });
  }
  // also accept a whole-message bare JSON object
  if (candidates.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      candidates.push({ raw: trimmed, consumed: trimmed, lenient: true });
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const spec = coerceRenderSpec(candidates[i].raw, candidates[i].lenient);
    if (spec) return { spec, consumed: candidates[i].consumed };
  }
  return null;
}

/** Back-compat convenience over extractAnswerSpec. */
export function extractRenderSpec(text: string): UxRenderSpec | null {
  return extractAnswerSpec(text)?.spec ?? null;
}

function coerceRenderSpec(raw: string, lenient: boolean): UxRenderSpec | null {
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
  if (!lenient) return null;
  const spec: UxRenderSpec = {};
  if (typeof o.title === 'string') spec.title = o.title;
  if (typeof o.body === 'string') spec.body = o.body;
  if (Array.isArray(o.items)) spec.items = o.items.map(coerceItem).filter(Boolean) as UxRenderItem[];
  // an "items" array whose entries all failed coercion must not become an
  // entirely blank card — require some surviving content.
  const hasContent = !!spec.title || !!spec.body || (spec.items?.length ?? 0) > 0;
  return hasContent ? spec : null;
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
  const found = extractAnswerSpec(text);
  if (found) {
    // Nothing the agent wrote is dropped: prose surrounding the consumed spec
    // joins the card body (a simple-shape spec often arrives with a sentence
    // of framing prose the user should still see).
    const prose = text.replace(found.consumed, '').replace(FENCE, '').trim();
    if (found.spec.ui || !prose) {
      return { id, kind: 'render', blocking: false, ts, spec: found.spec };
    }
    const body = [prose, found.spec.body].filter(Boolean).join('\n\n');
    return { id, kind: 'render', blocking: false, ts, spec: { ...found.spec, body } };
  }
  // No parseable spec. Keep the FULL text — including any fence that failed
  // coercion (deleting a quoted/mislabeled json blob would silently discard
  // data the agent fetched). Only a fence-only answer with no prose at all
  // gets the friendly failure card instead of a raw JSON echo.
  const prose = stripFences(text);
  const spec: UxRenderSpec = prose
    ? { body: text.trim() }
    : {
        title: 'Answer could not be displayed',
        body: 'The agent produced a layout that failed to parse. Ask it to try again.',
      };
  return { id, kind: 'render', blocking: false, ts, spec };
}
