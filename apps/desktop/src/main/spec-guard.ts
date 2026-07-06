/**
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

  let spec: unknown;
  try {
    spec = JSON.parse(specJson);
  } catch (err) {
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
      }
    }
  }

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
}
