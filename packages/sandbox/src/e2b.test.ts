/**
 * Guarded e2b smoke test — proves the E2bSandbox impl is real against a live
 * sandbox. SKIPS (exit 0) when E2B_API_KEY is absent so CI without a key passes.
 *
 *   E2B_API_KEY=… pnpm --filter @render/sandbox test:e2b
 */

import { strict as assert } from 'node:assert';
import { E2bSandbox } from './e2b.js';

async function main(): Promise<number> {
  if (!process.env.E2B_API_KEY) {
    process.stderr.write('[e2b.test] SKIP: E2B_API_KEY not set\n');
    return 0;
  }

  const sandbox = new E2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 60_000 });
  try {
    await sandbox.start({ env: { RENDER_SMOKE: '1' } });
    process.stderr.write(`[e2b.test] started, workdir=${sandbox.workdir()}\n`);

    const echo = await sandbox.exec('echo', ['hello-from-e2b']);
    assert.equal(echo.exitCode, 0, 'echo should exit 0');
    assert.match(echo.stdout, /hello-from-e2b/, 'stdout should contain marker');

    const fail = await sandbox.exec('sh', ['-c', 'exit 3']);
    assert.equal(fail.exitCode, 3, 'non-zero exit code should propagate');

    // spawn facade: collect stdout from a short background process
    const proc = sandbox.spawn('sh', ['-c', 'echo line1; echo line2']);
    const chunks: string[] = [];
    proc.onStdout((c) => chunks.push(c));
    const code = await new Promise<number | null>((resolve) => proc.onExit(resolve));
    assert.equal(code, 0, 'spawned process should exit 0');
    assert.match(chunks.join(''), /line1/, 'spawn stdout should stream');

    process.stderr.write('[e2b.test] PASS\n');
    return 0;
  } catch (e) {
    process.stderr.write(`[e2b.test] FAIL: ${e instanceof Error ? e.stack : String(e)}\n`);
    return 1;
  } finally {
    await sandbox.dispose();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`[e2b.test] fatal: ${String(e)}\n`);
    process.exit(1);
  },
);
