/**
 * Test runner: run the unit suite under node:test with tsx registered as the
 * TS loader (so the suite can import the package's `.ts` sources directly).
 * Mirrors opencli-bridge/test/run.mjs; tsx — already a devDependency here —
 * replaces its esbuild bundle step.
 *
 *   node test/run.mjs    (or: pnpm --filter @render/opencli-router test)
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const tsx = pathToFileURL(require.resolve('tsx')).href;
const suite = join(__dirname, 'router.unit.mjs');

const res = spawnSync(process.execPath, ['--import', tsx, '--test', suite], { stdio: 'inherit' });
process.exit(res.status ?? 1);
