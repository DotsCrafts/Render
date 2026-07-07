/**
 * Desktop unit-test runner: node:test over test/*.unit.mjs with the tsx loader
 * registered so suites can import main-process TypeScript sources directly (no
 * emit step, no Electron — the modules under test are electron-free). The
 * Electron-launching suites stay in test/*.e2e.mjs behind their own scripts
 * (test:nav / test:cdp).
 *
 *   node test/run.mjs    (or: pnpm --filter @render/desktop test)
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(__dirname)
  .filter((f) => f.endsWith('.unit.mjs'))
  .map((f) => join(__dirname, f));

if (files.length === 0) {
  console.error('[desktop-test] no *.unit.mjs suites found');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
  cwd: join(__dirname, '..'),
});
process.exit(res.status ?? 1);
