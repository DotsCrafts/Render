/**
<<<<<<< HEAD
 * spec-guard — deliver-time validation of a generated page (render-page).
 *
 * Runs before Render serves an agent-authored json-render spec through the
 * opencli-ux kernel. The catalog whitelist inside the kernel is the injection
 * boundary; THIS guard fails fast on what the kernel would only surface as a
 * dead widget or a rejected call at click time:
 *   • the spec must be valid JSON (an object);
 *   • every bound action must be a page action (ux_data / ux_submit /
 *     ux_confirm / ux_cancel) — chat-panel-only actions are rejected;
 *   • every ux_data request must be covered by the page's grants
 *     (--allow ∪ --allow-write), so no button is born dead;
 *   • grants must be well-formed "<site> <command>" pairs.
 *
 * RELAXED for the generated-page WRITE path (genpage-write-path): ux_submit /
 * ux_confirm are legal on delivered pages — the kernel runs them non-terminal
 * in keep mode and streams the payload back, which the runtime forwards into
 * the conversation. Direct writes ride per-command --allow-write grants, each
 * invocation human-confirmed through the ux-confirm-broker. What used to be a
 * blanket deliver-time rejection is now a shape check.
 */

/** Actions a generated PAGE may bind (panel-only actions like ux_instruct are not servable). */
const PAGE_ACTIONS = new Set(['ux_data', 'ux_submit', 'ux_confirm', 'ux_cancel']);

export interface SpecGuardResult {
  ok: boolean;
  errors: string[];
}

/** Parse a "<site> <command>,…" grant string; malformed entries become errors. */
export function parseGrants(raw: string | undefined, label: string, errors: string[]): Set<string> {
  const pairs = new Set<string>();
  for (const entry of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^\S+ \S+$/.test(entry)) pairs.add(entry);
    else errors.push(`${label}: "${entry}" is not a "<site> <command>" pair`);
  }
  return pairs;
}

/**
 * Validate a render-page spec + its grants. Never throws; collects every
 * problem so the agent can fix the spec in one pass.
 */
export function guardPageSpec(
  specJson: string,
  grants: { allow?: string; allowWrite?: string } = {},
): SpecGuardResult {
  const errors: string[] = [];
=======
 * spec-guard — deliver-time validation for agent-authored json-render page specs.
 *
 * The agent writes a spec file and runs `render-page`; before Render serves it
 * we check what the served ux-app can NOT check for us:
 *   • structural integrity (root resolves, elements are {type,…}, children link)
 *     — hard errors: a broken tree renders a blank tab with no message anywhere.
 *   • terminal actions (ux_submit / ux_confirm / ux_cancel) — hard errors: in
 *     `--keep` page mode those actions destroy the page and drop the user's
 *     input (the kernel's done-screen), so a Tier-2 page must never bind them.
 *   • ux_data requests vs the `--allow` list — hard errors: the kernel would
 *     403 them at click time; failing at deliver time lets the AGENT fix the
 *     allowlist instead of the human discovering a dead widget.
 *   • unknown component types — soft warnings only: the page renderer degrades
 *     gracefully (drops the element), and the served catalog lives in the
 *     opencli-ux checkout, so a hardcoded list must not hard-reject drift.
 *
 * Errors are returned as agent-actionable text — the runtime steers them back
 * into the live turn so the agent can repair the spec and re-run render-page.
 */

/** Component types the opencli-ux page catalog is known to serve today. */
const KNOWN_TYPES = new Set([
  // shadcn primitives
  'Stack',
  'Grid',
  'Card',
  'Heading',
  'Text',
  'Button',
  'Badge',
  'Table',
  'Tabs',
  'Accordion',
  'Input',
  'Select',
  'Link',
  'Separator',
  'Progress',
  'Image',
  'Avatar',
  // live-data templates
  'PortalShell',
  'MetricGrid',
  'FeedList',
  'WeatherPanel',
  'SearchPanel',
  'Map',
]);

/** Actions that terminate a kept page (kernel done-screen) — never allowed. */
const TERMINAL_ACTIONS = new Set(['ux_submit', 'ux_confirm', 'ux_cancel']);

export interface SpecGuardResult {
  ok: boolean;
  /** hard failures, written for the agent to act on */
  errors: string[];
  /** non-fatal drift signals (unknown component types etc.) */
  warnings: string[];
}

interface SpecElement {
  type?: unknown;
  children?: unknown;
  on?: unknown;
  watch?: unknown;
}

/**
 * Parse the `--allow "site cmd,…"` list into "site cmd" pairs — trim-only,
 * EXACTLY mirroring the ux.mjs kernel's own parsing. Normalizing whitespace
 * here would make the guard accept an entry (e.g. double-spaced) that the
 * kernel will 403 at runtime — the fail-fast promise would silently lie.
 */
function parseAllow(allow: string): Set<string> {
  return new Set(
    allow
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Walk every action binding of an element — `on.<event>` AND `watch.<path>`,
 * each of which is a single ActionBinding or an ARRAY of them, and bindings can
 * nest further bindings (onSuccess/onError chains). A shallow single-object
 * walk here is a real hole: a terminal ux_submit hidden in an array or a watch
 * would sail past the guard and destroy the page at click time.
 */
function bindings(el: SpecElement): Array<{ action: string; params?: Record<string, unknown> }> {
  const out: Array<{ action: string; params?: Record<string, unknown> }> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const h = node as { action?: unknown; params?: unknown };
    if (typeof h.action === 'string') {
      out.push({
        action: h.action,
        ...(h.params && typeof h.params === 'object'
          ? { params: h.params as Record<string, unknown> }
          : {}),
      });
    }
    // descend into nested bindings (onSuccess/onError, arbitrary chains) but
    // not into params — request payloads are captured above, not re-walked.
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'params') continue;
      if (value && typeof value === 'object') visit(value);
    }
  };
  for (const field of [el.on, el.watch]) {
    if (!field || typeof field !== 'object') continue;
    for (const handler of Object.values(field as Record<string, unknown>)) visit(handler);
  }
  return out;
}

/**
 * Validate an agent-authored page spec against the rules above. `specJson` must
 * already be known to parse (deliverPage JSON.parses first); a non-object or
 * shape mismatch still comes back as a hard error rather than a throw.
 */
export function validatePageSpec(specJson: string, allow: string): SpecGuardResult {
  const errors: string[] = [];
  const warnings: string[] = [];
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e

  let spec: unknown;
  try {
    spec = JSON.parse(specJson);
  } catch (err) {
<<<<<<< HEAD
    return { ok: false, errors: [`spec is not valid JSON — ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: ['spec must be a JSON object'] };
  }

  const allow = parseGrants(grants.allow, '--allow', errors);
  const allowWrite = parseGrants(grants.allowWrite, '--allow-write', errors);
  const granted = new Set([...allow, ...allowWrite]);

  // Simple shapes ({title,body,items} / lowered forms) carry no action bindings.
  const s = spec as { root?: unknown; elements?: unknown };
  if (s.elements !== undefined || s.root !== undefined) {
    if (!s.elements || typeof s.elements !== 'object' || Array.isArray(s.elements)) {
      errors.push('spec.elements must be an object of elements');
    } else {
      for (const [id, el] of Object.entries(s.elements as Record<string, unknown>)) {
        checkElementActions(id, el, granted, errors);
=======
    return { ok: false, errors: [`spec is not valid JSON: ${String(err)}`], warnings };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: ['spec must be a JSON object of shape {root, state, elements}'], warnings };
  }
  const s = spec as { root?: unknown; elements?: unknown };
  if (typeof s.root !== 'string' || !s.root) {
    errors.push('spec.root must be the id (string) of the entry element');
  }
  if (!s.elements || typeof s.elements !== 'object' || Array.isArray(s.elements)) {
    errors.push('spec.elements must be an object map of id → element');
    return { ok: false, errors, warnings };
  }

  const elements = s.elements as Record<string, SpecElement>;
  if (typeof s.root === 'string' && !(s.root in elements)) {
    errors.push(`spec.root "${s.root}" does not exist in elements`);
  }

  const allowed = parseAllow(allow);
  for (const [id, el] of Object.entries(elements)) {
    if (!el || typeof el !== 'object') {
      errors.push(`element "${id}" is not an object`);
      continue;
    }
    if (typeof el.type !== 'string' || !el.type) {
      errors.push(`element "${id}" is missing a component "type"`);
    } else if (!KNOWN_TYPES.has(el.type)) {
      warnings.push(`element "${id}" uses unknown component type "${el.type}" — it will render as empty`);
    }
    if (el.children !== undefined) {
      if (!Array.isArray(el.children)) {
        errors.push(`element "${id}".children must be an array of element ids`);
      } else {
        for (const child of el.children) {
          if (typeof child !== 'string' || !(child in elements)) {
            errors.push(`element "${id}" links missing child "${String(child)}"`);
          }
        }
      }
    }
    for (const b of bindings(el)) {
      if (TERMINAL_ACTIONS.has(b.action)) {
        errors.push(
          `element "${id}" binds "${b.action}" — forbidden on a render-page (it destroys the page); bind ux_data instead`,
        );
      }
      if (b.action === 'ux_data') {
        const req = b.params?.request as { site?: unknown; command?: unknown } | undefined;
        const site = typeof req?.site === 'string' ? req.site : '';
        const command = typeof req?.command === 'string' ? req.command : '';
        if (!site || !command) {
          errors.push(`element "${id}" binds ux_data without request.site/request.command`);
        } else if (!allowed.has(`${site} ${command}`)) {
          errors.push(
            `element "${id}" requests "${site} ${command}" which is not in --allow "${allow}" — add it to --allow or fix the request`,
          );
        }
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
      }
    }
  }

<<<<<<< HEAD
  return { ok: errors.length === 0, errors };
}

function checkElementActions(id: string, el: unknown, granted: Set<string>, errors: string[]): void {
  if (!el || typeof el !== 'object') return;
  const on = (el as { on?: unknown }).on;
  if (!on || typeof on !== 'object' || Array.isArray(on)) return;
  for (const [event, bound] of Object.entries(on as Record<string, unknown>)) {
    for (const action of Array.isArray(bound) ? bound : [bound]) {
      checkAction(`${id}.on.${event}`, action, granted, errors);
    }
  }
}

function checkAction(where: string, action: unknown, granted: Set<string>, errors: string[]): void {
  if (!action || typeof action !== 'object') {
    errors.push(`${where}: action binding must be an object`);
    return;
  }
  const a = action as { action?: unknown; params?: unknown };
  const name = typeof a.action === 'string' ? a.action : '';
  if (!PAGE_ACTIONS.has(name)) {
    errors.push(`${where}: "${name || String(a.action)}" is not a page action (allowed: ${[...PAGE_ACTIONS].join(', ')})`);
    return;
  }
  if (name !== 'ux_data') return;

  // a ux_data binding must reference a granted "<site> <command>" — otherwise
  // the widget is born dead (the kernel would 403 it at fetch time).
  const params = a.params && typeof a.params === 'object' ? (a.params as { request?: unknown }) : undefined;
  const request = params?.request && typeof params.request === 'object' ? (params.request as { site?: unknown; command?: unknown }) : undefined;
  const site = typeof request?.site === 'string' ? request.site : '';
  const command = typeof request?.command === 'string' ? request.command : '';
  if (!site || !command) {
    errors.push(`${where}: ux_data needs params.request.site + .command`);
    return;
  }
  const pair = `${site} ${command}`;
  if (!granted.has(pair)) {
    errors.push(`${where}: ux_data runs "${pair}" but it is not granted — add it to --allow (reads) or --allow-write (writes)`);
  }
=======
  return { ok: errors.length === 0, errors, warnings };
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
}
