/**
 * Build an opencli argv from an `OpencliInvocation` + adapter metadata.
 *
 * Positional args (per metadata) are emitted in declared order as bare values;
 * everything else becomes `--flag value` (or a bare `--flag` for booleans).
 * Without metadata we degrade gracefully: all args become flags.
 */

import type { OpencliInvocation } from '@render/protocol';
import type { CommandMeta } from './types.js';

export type OpencliFormat = NonNullable<OpencliInvocation['format']>;

export function buildArgv(
  inv: OpencliInvocation,
  meta: CommandMeta | undefined,
  format: OpencliFormat,
): string[] {
  const args = inv.args ?? {};
  const positionalNames = (meta?.args ?? []).filter((a) => a.positional).map((a) => a.name);
  const positionalSet = new Set(positionalNames);

  const positionals: string[] = [];
  for (const name of positionalNames) {
    if (name in args) positionals.push(String(args[name]));
  }

  const flags: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    if (positionalSet.has(name)) continue;
    if (typeof value === 'boolean') {
      if (value) flags.push(`--${name}`);
    } else {
      flags.push(`--${name}`, String(value));
    }
  }

  return [inv.site, inv.command, ...positionals, ...flags, '-f', format];
}
