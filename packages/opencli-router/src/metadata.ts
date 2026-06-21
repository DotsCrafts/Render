/**
 * Adapter classification driven by REAL opencli metadata.
 *
 * `opencli list -f json` reports, per command, its `strategy`
 * (public | cookie | ui | intercept | local) and a `browser` flag. We load it
 * once (through the sandbox) and map opencli's taxonomy onto the protocol's
 * three-value `AdapterStrategy`:
 *
 *   cookie                       → 'cookie'   (logged-in session over CDP)
 *   browser=true (ui/intercept…) → 'browser'  (real Chromium tab over CDP)
 *   public / local, headless     → 'public'   (sandbox, no auth)
 */

import type { AdapterStrategy } from '@render/protocol';
import { extractJson } from './parse.js';
import type { ArgMeta, CommandMeta, OpencliExec } from './types.js';

export function mapStrategy(meta: Pick<CommandMeta, 'rawStrategy' | 'browser'>): AdapterStrategy {
  if (meta.rawStrategy === 'cookie') return 'cookie';
  if (meta.browser) return 'browser';
  return 'public';
}

interface RawCommand {
  command?: unknown;
  site?: unknown;
  name?: unknown;
  strategy?: unknown;
  browser?: unknown;
  access?: unknown;
  domain?: unknown;
  args?: unknown;
}

function toArgMeta(raw: unknown): ArgMeta | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const a = raw as Record<string, unknown>;
  if (typeof a.name !== 'string') return undefined;
  return {
    name: a.name,
    type: typeof a.type === 'string' ? a.type : 'string',
    required: a.required === true,
    positional: a.positional === true,
  };
}

function toMeta(raw: RawCommand): CommandMeta | undefined {
  if (typeof raw.site !== 'string' || typeof raw.name !== 'string') return undefined;
  const args = Array.isArray(raw.args)
    ? raw.args.map(toArgMeta).filter((a): a is ArgMeta => a !== undefined)
    : [];
  return {
    command: typeof raw.command === 'string' ? raw.command : `${raw.site}/${raw.name}`,
    site: raw.site,
    name: raw.name,
    rawStrategy: typeof raw.strategy === 'string' ? raw.strategy : 'public',
    browser: raw.browser === true,
    access: typeof raw.access === 'string' ? raw.access : 'read',
    args,
    domain: typeof raw.domain === 'string' ? raw.domain : undefined,
  };
}

export class MetadataIndex {
  readonly #byKey = new Map<string, CommandMeta>();
  readonly #domainBySite = new Map<string, string>();
  #loaded = false;

  get loaded(): boolean {
    return this.#loaded;
  }

  /** Load `opencli list -f json` via the injected runner (idempotent). */
  async load(run: () => Promise<OpencliExec>): Promise<void> {
    if (this.#loaded) return;
    const res = await run();
    const parsed = extractJson(res.stdout);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `opencli list returned no JSON (exit ${res.exitCode}): ${res.stderr.slice(0, 200)}`,
      );
    }
    for (const raw of parsed) {
      const meta = toMeta(raw as RawCommand);
      if (!meta) continue;
      this.#byKey.set(key(meta.site, meta.name), meta);
      if (meta.domain && !this.#domainBySite.has(meta.site)) {
        this.#domainBySite.set(meta.site, meta.domain);
      }
    }
    this.#loaded = true;
  }

  get(site: string, command: string): CommandMeta | undefined {
    return this.#byKey.get(key(site, command));
  }

  domainFor(site: string): string | undefined {
    return this.#domainBySite.get(site);
  }

  get size(): number {
    return this.#byKey.size;
  }
}

const key = (site: string, command: string): string => `${site}/${command}`;
