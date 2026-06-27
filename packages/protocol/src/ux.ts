/**
 * Render UX message contract — every agent reply is one of these.
 *
 * Lifted from the opencli-ux jsonrender contract (render/form/confirm) and
 * extended with `login` for the Plane-2 (web auth) human-hand journey.
 *
 * Field shapes are kept verbatim-compatible with opencli-ux/examples/*.json so
 * the same @json-render/shadcn catalog renders both. The renderer is catalog-
 * whitelisted: an LLM-authored spec may only reference known components/actions,
 * so structure (not sanitization) is the injection boundary.
 */

export type UxKind = 'render' | 'form' | 'confirm' | 'login' | 'block';

/**
 * A saved/savable render-page reference attached to a `render` result card. Set
 * by the runtime when it serves a Tier-2 page (deliverPage) so the card's
 * next-step row can offer Save / Ask-agent against the persisted spec.
 */
export interface UxPageRef {
  /** persisted page id (userData/pages/<id>/v<n>.json) */
  id: string;
  title: string;
  /** true once the human explicitly saved it to the Saved-Pages gallery */
  saved?: boolean;
}

/** Discriminated envelope carried over IPC and through the event stream. */
export interface UxMessage<K extends UxKind = UxKind> {
  /** correlates a reply (form values / confirm choice) back to the agent seam */
  id: string;
  kind: K;
  /** true ⇒ the agent turn is paused awaiting this message's resolution */
  blocking: boolean;
  spec: UxSpecFor<K>;
  /** optional: the codex itemId / server-request id this maps to */
  origin?: { threadId?: string; turnId?: string; itemId?: string; requestId?: number | string };
  /** present on `render` cards that opened a savable Tier-2 page */
  page?: UxPageRef;
  ts: number;
}

export type UxSpecFor<K extends UxKind> = K extends 'render'
  ? UxRenderSpec
  : K extends 'form'
    ? UxFormSpec
    : K extends 'confirm'
      ? UxConfirmSpec
      : K extends 'block'
        ? UxBlockSpec
        : UxLoginSpec;

// ── a. ux render — normal replies + structured results (non-blocking) ────────

export interface UxRenderSpec {
  title?: string;
  /** plain prose body (markdown-ish), rendered safely above items */
  body?: string;
  items?: UxRenderItem[];
  /**
   * A full @json-render Spec ({ root, elements, state }) for a dynamic,
   * content-appropriate UI composed from the catalog (Table, Tabs, Grid, Badge,
   * Progress, …). When present it takes precedence over title/body/items — the
   * renderer passes it through the catalog whitelist (structure is the injection
   * boundary) with a prose fallback if it fails to render. This is what makes the
   * agent's output genuinely generative, not a fixed card template.
   */
  ui?: unknown;
}
export interface UxRenderItem {
  title?: string;
  subtitle?: string;
  image?: string;
  url?: string;
  fields?: Record<string, string | number>;
}

// ── b. ux form — submit to app layer (options / table / percent / inputs) ────

export type UxFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'password'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'switch';

export interface UxFormField {
  name: string;
  type: UxFieldType;
  label?: string;
  placeholder?: string;
  options?: string[]; // required for select / multiselect
  value?: unknown; // prefill
}
export interface UxFormSpec {
  title?: string;
  fields: UxFormField[];
  submitLabel?: string;
}
export interface UxFormResult {
  action: 'ux_submit' | 'ux_cancel';
  values?: Record<string, unknown>;
}

// ── c. ux confirm — reasoning block, route a choice to the human ─────────────

export interface UxConfirmSpec {
  message: string;
  options?: string[]; // defaults ["允许","拒绝"]
  danger?: boolean;
  /** optional unified diff / detail the human should inspect before choosing */
  detail?: string;
}
export interface UxConfirmResult {
  action: 'ux_confirm' | 'ux_cancel';
  choice?: string;
}

// ── c2. block — the agent is stuck / needs a decision; steer it inline ───────
//
// The missing core of surface (a): a card that says "I need a decision" with an
// optional set of choices AND a free-text instruction field, so the human steers
// the paused (or just-finished) turn from the card itself instead of the detached
// global input. Choices route through ux_confirm (reusing the existing action);
// the free-text steer routes through the 5th catalog action, ux_instruct.

export interface UxBlockOption {
  /** the choice the human picks; echoed back as UxBlockResult.choice */
  label: string;
  /** optional trailing meta, e.g. a price or ETA, shown right-aligned */
  meta?: string;
}
export interface UxBlockSpec {
  /** the decision the agent needs from the human */
  question: string;
  /** optional discrete choices; omit for an instruction-only block */
  options?: UxBlockOption[];
  /** show the free-text steer field (default: true) */
  allowInstruction?: boolean;
  /** label above the steer field */
  instructionLabel?: string;
  instructionPlaceholder?: string;
  /** label for the steer send button (default: "Send") */
  submitLabel?: string;
  /** render the first choice as a destructive action + a caution note */
  danger?: boolean;
}
export interface UxBlockResult {
  action: 'ux_confirm' | 'ux_instruct' | 'ux_cancel';
  /** set when the human picked one of `options` (action: ux_confirm) */
  choice?: string;
  /** set when the human typed a free-text steer (action: ux_instruct) */
  instruction?: string;
}

// ── d. login — external auth via opencli login over the CDP human-hand ───────

export interface UxLoginSpec {
  /** opencli site/adapter alias, e.g. "zhihu", "dianping" */
  site: string;
  /** human-facing reason the agent needs this session */
  reason?: string;
  /** url to open in the human-hand Chromium tab to begin login */
  loginUrl?: string;
  /** predicate the relay polls to detect success (adapter-defined) */
  successHint?: string;
}
export interface UxLoginResult {
  action: 'login_done' | 'login_cancel';
  loggedIn: boolean;
  account?: string;
}

export type UxResult = UxFormResult | UxConfirmResult | UxLoginResult | UxBlockResult;

// Action names the @json-render catalog whitelists (no other actions allowed).
export const UX_ACTION = {
  submit: 'ux_submit',
  confirm: 'ux_confirm',
  cancel: 'ux_cancel',
  instruct: 'ux_instruct',
  loginDone: 'login_done',
} as const;
