/**
 * Test runner: bundle the TS unit suite with esbuild (so it can import the
 * package's `.ts` sources directly) and run it under node:test. Avoids a
 * separate emit step and keeps the suite source in TypeScript-importing ESM.
 *
 *   node test/run.mjs    (or: pnpm --filter @render/opencli-bridge test)
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const esbuild = require('esbuild');

const out = join(__dirname, '..', 'node_modules', '.cache', 'bridge.unit.bundle.mjs');
esbuild.buildSync({
  entryPoints: [resolve(__dirname, 'bridge.unit.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  external: ['node:*'],
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
});

const res = spawnSync(process.execPath, ['--test', out], { stdio: 'inherit' });
process.exit(res.status ?? 1);
