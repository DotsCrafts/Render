/**
 * Parse an app-hand opencli command typed into the floating input.
 *
 *   /opencli arxiv search query="retrieval augmented generation" limit=3
 *   /oc 12306 me
 *   /opencli arxiv search "large language models"   ← bare tokens → `query`
 *
 * Returns null for ordinary prompts (those go to codex). The grammar is small
 * on purpose: site + command, then `key=value` args (quotes respected, numeric
 * values coerced) plus a convenience where bare tokens collapse into `query`.
 */

import type { OpencliInvocation } from '@render/protocol';

const PREFIXES = ['/opencli', '/oc'];

export function parseOpencliCommand(text: string): OpencliInvocation | null {
  const trimmed = text.trim();
  const prefix = PREFIXES.find((p) => trimmed === p || trimmed.startsWith(`${p} `));
  if (!prefix) return null;

  const rest = trimmed.slice(prefix.length).trim();
  const tokens = tokenize(rest);
  if (tokens.length < 2) return null;

  const [site, command, ...argTokens] = tokens;
  const args: Record<string, string | number | boolean> = {};
  const bare: string[] = [];

  for (const token of argTokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) {
      bare.push(stripQuotes(token));
      continue;
    }
    const key = token.slice(0, eq);
    args[key] = coerce(stripQuotes(token.slice(eq + 1)));
  }

  // Convenience: bare tokens (the common single positional) collapse into query.
  if (bare.length && args.query === undefined) args.query = bare.join(' ');

  return { site, command, args, format: 'json' };
}

/** Split on whitespace while keeping single/double quoted runs intact. */
function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerce(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}
