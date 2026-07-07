/**
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

  let spec: unknown;
  try {
    spec = JSON.parse(specJson);
  } catch (err) {
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
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
