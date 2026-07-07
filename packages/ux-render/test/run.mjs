/**
 * Test runner: bundle the unit suite with esbuild (so it can import the
 * package's `.tsx` sources directly) and run it under node:test. esbuild is
 * not a direct dependency here — we borrow the copy vite ships with, which
 * keeps the package's dependency set unchanged.
 *
 *   node test/run.mjs    (or: pnpm --filter @render/ux-render test)
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');

const out = join(__dirname, '..', 'node_modules', '.cache', 'feed.unit.bundle.mjs');
esbuild.buildSync({
  entryPoints: [resolve(__dirname, 'feed.unit.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  jsx: 'automatic',
  outfile: out,
  external: ['node:*'],
  banner: {
    js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  },
});

const res = spawnSync(process.execPath, ['--test', out], { stdio: 'inherit' });
process.exit(res.status ?? 1);
