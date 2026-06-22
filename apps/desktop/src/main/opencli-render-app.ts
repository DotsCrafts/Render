/**
 * Register Render as an opencli "Electron app" so opencli drives RENDER's
 * embedded Chromium over CDP — not the user's system Chrome.
 *
 * opencli routes a command to its direct-CDP client (`CDPBridge`) only when the
 * command's site is a registered Electron app (`~/.opencli/apps.yaml`); every
 * other site goes through the extension bridge → system Chrome. So we:
 *   1. add a `render` app entry (port = Render's --remote-debugging-port), and
 *   2. install a `render` debug adapter (`~/.opencli/clis/render/*.js`):
 *      get · text · status · eval · nav · html · snapshot — driving Render's
 *      own tabs over CDP, a debugging handle independent of the bridge path.
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

/**
 * The render adapter command files, embedded so the built app is self-contained.
 * A debugging palette over Render's own tabs (CDP): get, text, status, eval,
 * nav, html, snapshot. Each is self-contained (registry + node fs only) because
 * a user-installed adapter under ~/.opencli/clis can't import opencli's builtin
 * `_shared` helpers. NOTE on escaping: these are TS template literals, so any
 * backslash meant for the emitted .js (e.g. a regex) must be doubled here.
 */
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
  'status.js': `import { cli, Strategy } from '@jackwener/opencli/registry';
// Confirm the CDP route is live and report the active tab.
export const statusCommand = cli({
  site: 'render',
  name: 'status',
  access: 'read',
  description: 'Check the Render CDP connection and active tab (debug)',
  domain: 'localhost',
  strategy: Strategy.UI,
  browser: true,
  args: [],
  columns: ['status', 'url', 'title'],
  func: async (page) => {
    const url = await page.evaluate('location.href');
    const title = await page.evaluate('document.title');
    return [{ status: 'connected', url, title }];
  },
});
`,
  'eval.js': `import { cli, Strategy } from '@jackwener/opencli/registry';
// Run arbitrary JS in Render's active tab and return the result (debug).
export const evalCommand = cli({
  site: 'render',
  name: 'eval',
  access: 'read',
  description: "Evaluate a JS expression in Render's active tab (debug)",
  domain: 'localhost',
  strategy: Strategy.UI,
  browser: true,
  args: [{ name: 'js', required: true, positional: true, help: 'JS expression to evaluate in the active tab' }],
  columns: ['result'],
  func: async (page, kwargs) => {
    const value = await page.evaluate(kwargs.js);
    let result;
    try {
      result = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      result = String(value);
    }
    return [{ result: result === undefined ? 'undefined' : result }];
  },
});
`,
  'nav.js': `import { cli, Strategy } from '@jackwener/opencli/registry';
// Navigate Render's active tab to a URL (debug). Read-access for low friction.
export const navCommand = cli({
  site: 'render',
  name: 'nav',
  access: 'read',
  description: "Navigate Render's active tab to a URL (debug)",
  domain: 'localhost',
  strategy: Strategy.UI,
  browser: true,
  args: [{ name: 'url', required: true, positional: true, help: 'URL to load in the active tab' }],
  columns: ['url', 'title'],
  func: async (page, kwargs) => {
    await page.evaluate('location.assign(' + JSON.stringify(kwargs.url) + ')');
    await page.wait(1);
    const url = await page.evaluate('location.href');
    const title = await page.evaluate('document.title');
    return [{ url, title }];
  },
});
`,
  'html.js': `import { cli, Strategy } from '@jackwener/opencli/registry';
import { writeFileSync } from 'node:fs';
// Dump the active tab's outerHTML to a file (debug).
export const htmlCommand = cli({
  site: 'render',
  name: 'html',
  access: 'read',
  description: "Dump Render's active tab outerHTML to a file (debug)",
  domain: 'localhost',
  strategy: Strategy.UI,
  browser: true,
  args: [{ name: 'output', required: false, help: 'Output file (default: /tmp/render-dom.html)' }],
  columns: ['file', 'bytes', 'url'],
  func: async (page, kwargs) => {
    const out = kwargs.output || '/tmp/render-dom.html';
    const html = await page.evaluate('document.documentElement.outerHTML');
    writeFileSync(out, html);
    const url = await page.evaluate('location.href');
    return [{ file: out, bytes: html.length, url }];
  },
});
`,
  'snapshot.js': `import { cli, Strategy } from '@jackwener/opencli/registry';
import { writeFileSync } from 'node:fs';
// Capture the active tab's DOM + accessibility snapshot to files (debug).
export const snapshotCommand = cli({
  site: 'render',
  name: 'snapshot',
  access: 'read',
  description: "Capture Render's active tab DOM + a11y snapshot to files (debug)",
  domain: 'localhost',
  strategy: Strategy.UI,
  browser: true,
  args: [{ name: 'output', required: false, help: 'Output base path (default: /tmp/render-snapshot.txt)' }],
  columns: ['status', 'file'],
  func: async (page, kwargs) => {
    const base = (kwargs.output || '/tmp/render-snapshot.txt').replace(/\\.\\w+$/, '');
    const html = await page.evaluate('document.documentElement.outerHTML');
    const snap = await page.snapshot({ compact: true });
    const htmlPath = base + '-dom.html';
    const a11yPath = base + '-a11y.txt';
    writeFileSync(htmlPath, html);
    writeFileSync(a11yPath, typeof snap === 'string' ? snap : JSON.stringify(snap, null, 2));
    return [{ status: 'ok', file: htmlPath }, { status: 'ok', file: a11yPath }];
  },
});
`,
};

const RENDER_APP_BLOCK = (port: number): string =>
  `  render:\n    port: ${port}\n    processName: Render\n    displayName: Render\n`;

/** True if the YAML already declares a `render:` app under `apps:`. */
const hasRenderApp = (yaml: string): boolean => /^\s{2,}render:\s*$/m.test(yaml);

/**
 * Insert OR port-correct the `render` app entry in apps.yaml.
 *
 * Self-healing: opencli only honors the CDP route for a registered app at the
 * port in apps.yaml. A stale entry (e.g. left by the e2e harness on a different
 * port) would silently point `opencli render` at a dead port, so we rewrite an
 * existing `render:` block to the CURRENT instance's port rather than bail.
 * Otherwise additive — never touches other apps.
 */
export function mergeRenderApp(existing: string, port: number): string {
  const block = RENDER_APP_BLOCK(port);
  if (hasRenderApp(existing)) {
    // replace the existing `  render:` block (its 4-space-indented children) in place
    return existing.replace(/^ {2}render:\n(?: {4}.*\n?)*/m, block);
  }
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

    // 2. apps.yaml — insert or port-correct (self-healing; see mergeRenderApp)
    const existing = await readFile(appsYaml, 'utf8').catch(() => '');
    const merged = mergeRenderApp(existing, opts.port);
    if (merged !== existing) await writeFile(appsYaml, merged);
    const note = !hasRenderApp(existing)
      ? 'registered'
      : merged === existing
        ? 'already current'
        : `port corrected → ${opts.port}`;
    return { registered: true, appsYaml, adapterDir, note };
  } catch (err) {
    return {
      registered: false,
      appsYaml,
      adapterDir,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}
