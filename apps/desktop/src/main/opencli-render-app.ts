/**
 * Register Render as an opencli "Electron app" so opencli drives RENDER's
 * embedded Chromium over CDP — not the user's system Chrome.
 *
 * opencli routes a command to its direct-CDP client (`CDPBridge`) only when the
 * command's site is a registered Electron app (`~/.opencli/apps.yaml`); every
 * other site goes through the extension bridge → system Chrome. So we:
 *   1. add a `render` app entry (port = Render's --remote-debugging-port), and
 *   2. install a tiny `render` adapter (`~/.opencli/clis/render/*.js`) exposing
 *      read-only browser commands (`get`, `text`).
 *
 * With both present, `OPENCLI_CDP_ENDPOINT=http://127.0.0.1:<port> opencli render get`
 * connects straight to Render's tabs over CDP. Proven in
 * apps/desktop/test/cdp-opencli.e2e.mjs.
 *
 * Best-effort and idempotent: additive to the user's apps.yaml (never clobbers
 * existing entries), and a no-op if the render entry already exists. Failures are
 * swallowed — Render still runs; only the opencli→Render CDP route is unavailable.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RegisterResult {
  registered: boolean;
  appsYaml: string;
  adapterDir: string;
  note?: string;
}

/** The render adapter command files, embedded so the built app is self-contained. */
const ADAPTER_FILES: Record<string, string> = {
  'get.js': `import { cli, Strategy } from '@jackwener/opencli/registry';
// Read the active Render tab's URL + title over CDP (proves the CDP route).
export const getCommand = cli({
  site: 'render',
  name: 'get',
  access: 'read',
  description: "Read Render's active tab url + title over CDP",
  domain: 'localhost',
  strategy: Strategy.UI,
  browser: true,
  args: [],
  columns: ['url', 'title'],
  func: async (page) => {
    const url = await page.evaluate('location.href');
    const title = await page.evaluate('document.title');
    return [{ url, title }];
  },
});
`,
  'text.js': `import { cli, Strategy } from '@jackwener/opencli/registry';
// Extract the visible text of Render's active tab over CDP.
export const textCommand = cli({
  site: 'render',
  name: 'text',
  access: 'read',
  description: "Extract Render's active tab visible text over CDP",
  domain: 'localhost',
  strategy: Strategy.UI,
  browser: true,
  args: [],
  columns: ['url', 'text'],
  func: async (page) => {
    const url = await page.evaluate('location.href');
    const text = await page.evaluate('document.body ? document.body.innerText : ""');
    return [{ url, text }];
  },
});
`,
};

const RENDER_APP_BLOCK = (port: number): string =>
  `  render:\n    port: ${port}\n    processName: Render\n    displayName: Render\n`;

/** True if the YAML already declares a `render:` app under `apps:`. */
const hasRenderApp = (yaml: string): boolean => /^\s{2,}render:\s*$/m.test(yaml);

/** Merge a `render` app entry into existing apps.yaml text (additive). */
export function mergeRenderApp(existing: string, port: number): string {
  if (hasRenderApp(existing)) return existing;
  const block = RENDER_APP_BLOCK(port);
  if (/^apps:\s*$/m.test(existing)) {
    // insert right after the top-level `apps:` line
    return existing.replace(/^apps:\s*$/m, (m) => `${m}\n${block.replace(/\n$/, '')}`);
  }
  const prefix = existing.trim() ? `${existing.replace(/\s*$/, '')}\n` : '';
  return `${prefix}apps:\n${block}`;
}

export async function registerRenderOpencliApp(opts: {
  port: number;
  /** override the opencli home (defaults to ~/.opencli) — used by tests */
  opencliHome?: string;
}): Promise<RegisterResult> {
  const home = opts.opencliHome ?? join(homedir(), '.opencli');
  const appsYaml = join(home, 'apps.yaml');
  const adapterDir = join(home, 'clis', 'render');

  try {
    await mkdir(adapterDir, { recursive: true });

    // 1. adapter files (overwrite — they're ours and version with Render)
    for (const [name, body] of Object.entries(ADAPTER_FILES)) {
      await writeFile(join(adapterDir, name), body);
    }

    // 2. apps.yaml — additive merge
    const existing = await readFile(appsYaml, 'utf8').catch(() => '');
    if (hasRenderApp(existing)) {
      return { registered: true, appsYaml, adapterDir, note: 'already registered' };
    }
    await writeFile(appsYaml, mergeRenderApp(existing, opts.port));
    return { registered: true, appsYaml, adapterDir };
  } catch (err) {
    return {
      registered: false,
      appsYaml,
      adapterDir,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}
