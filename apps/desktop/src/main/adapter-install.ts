/**
 * adapter-install — the trusted half of the `render-adapter` shim.
 *
 * The agent's sandbox can READ every kernel layer (traces, adapter sources)
 * but can only WRITE its own workdir. Adapter code, however, executes in the
 * opencli daemon OUTSIDE the sandbox — so installing one is a privilege
 * boundary crossing and stays in the main process, behind a human confirm
 * (the runtime raises the card; this module only validates and writes).
 *
 * Installs land in `~/.opencli/clis/<site>/<name>.js` — opencli's documented
 * local-override location (shadows the packaged adapter inside the signed
 * OpenCLIApp bundle, which must never be edited). An existing file is backed
 * up alongside before being replaced.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AdapterInstallResult {
  ok: boolean;
  /** absolute installed path on success */
  path?: string;
  /** true when an existing override was replaced (backup written) */
  replaced?: boolean;
  error?: string;
}

export interface AdapterInstaller {
  /** Validate and install a staged adapter file. `target` = "<site>/<name>.js". */
  install(target: string, stagedPath: string): AdapterInstallResult;
}

/** site dir and file name are lowercase slugs; only .js adapter files. */
const TARGET_RE = /^([a-z0-9][a-z0-9_.-]{0,63})\/([a-z0-9][a-z0-9_.-]{0,63}\.js)$/i;

/** A staged adapter larger than this is almost certainly not an adapter. */
const MAX_ADAPTER_BYTES = 256 * 1024;

export function createAdapterInstaller(opts: { clisDir?: string; now?: () => number } = {}): AdapterInstaller {
  const clisDir = opts.clisDir ?? join(homedir(), '.opencli', 'clis');
  const now = opts.now ?? (() => Date.now());

  const install = (target: string, stagedPath: string): AdapterInstallResult => {
    const match = TARGET_RE.exec(target.trim());
    if (!match) {
      return { ok: false, error: `invalid adapter target ${JSON.stringify(target)} — expected <site>/<name>.js` };
    }
    const [, site, file] = match;
    if (site.toLowerCase() === '_shared') {
      // _shared helpers back EVERY auth adapter — a bad write there bricks the
      // whole catalog. Patches must stay site-scoped.
      return { ok: false, error: 'installing into _shared is not allowed — patch the site adapter instead' };
    }
    if (!stagedPath.startsWith('/') || !existsSync(stagedPath)) {
      return { ok: false, error: `staged adapter file not found: ${stagedPath}` };
    }
    let source: string;
    try {
      const size = statSync(stagedPath).size;
      if (size === 0) return { ok: false, error: 'staged adapter file is empty' };
      if (size > MAX_ADAPTER_BYTES) {
        return { ok: false, error: `staged adapter is ${size} bytes — over the ${MAX_ADAPTER_BYTES} limit` };
      }
      source = readFileSync(stagedPath, 'utf8');
    } catch (err) {
      return { ok: false, error: `cannot read staged adapter: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (source.includes('\u0000')) {
      return { ok: false, error: 'staged adapter is not a text file' };
    }

    try {
      const dir = join(clisDir, site);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, file);
      const replaced = existsSync(dest);
      if (replaced) copyFileSync(dest, `${dest}.bak-${now()}`);
      writeFileSync(dest, source);
      return { ok: true, path: dest, replaced };
    } catch (err) {
      return { ok: false, error: `install failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  return { install };
}
