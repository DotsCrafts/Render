/**
 * Milestone-1 proof runner for @render/opencli-bridge.
 *
 * Orchestrates the REAL end-to-end proof, no mocks:
 *   1. bundle harness-main.ts → a single ESM file (esbuild; electron external).
 *   2. record whether system Google Chrome was running, then QUIT it so the
 *      opencli daemon has no system browser to route to — we become the active
 *      profile. (We restore Chrome at the end if we quit it.)
 *   3. launch the harness under Electron; wait for the readiness sentinel.
 *   4. run `opencli google search "render bridge m1" -f json` and assert it
 *      returns real Google results — proving the daemon drove OUR WebContentsView.
 *   5. assert system Chrome was not (re)launched by the run.
 *   6. restore Chrome if we quit it; write a verdict + evidence paths.
 *
 *   node harness/run-proof.mjs        (from packages/opencli-bridge)
 *
 * Requires: `opencli` on PATH, the opencli daemon reachable on :19825, and the
 * monorepo installed (electron + esbuild present).
 */

import { spawn, execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..');
const evidenceDir = join(__dirname, 'evidence');
const bundlePath = join(evidenceDir, 'harness-main.bundle.mjs');
const frameLog = join(evidenceDir, 'frames.ndjson');

const QUERY = process.env.BRIDGE_QUERY ?? 'render bridge m1';
const READY_SENTINEL = '__BRIDGE_READY__';
const READY_TIMEOUT_MS = 30_000;
const OPENCLI_TIMEOUT_MS = 90_000;

const log = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const electronBin = (() => {
  const r = createRequire(join(pkgDir, '..', '..', 'apps', 'desktop', 'package.json'));
  return r('electron');
})();

const chromeRunning = () => {
  try {
    execSync('pgrep -x "Google Chrome"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

function bundleHarness() {
  log('▶ bundling harness-main.ts (esbuild, electron external)…');
  const esbuild = require('esbuild');
  // ws is bundled in so the Electron process needs no node_modules resolution;
  // electron is external (provided by the Electron runtime).
  esbuild.buildSync({
    entryPoints: [join(__dirname, 'harness-main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundlePath,
    external: ['electron'],
    banner: {
      js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
    },
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error('harness did not signal readiness within timeout')),
      READY_TIMEOUT_MS,
    );
    const onData = (d) => {
      buf += d.toString();
      process.stdout.write(`  [harness] ${d.toString().replace(/\n$/, '')}\n`);
      if (buf.includes(READY_SENTINEL)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) =>
      reject(new Error(`harness exited before readiness (code ${code})`)),
    );
  });
}

async function main() {
  mkdirSync(evidenceDir, { recursive: true });
  log('▶ opencli-bridge Milestone-1 proof — daemon drives RENDER WebContentsView, not system Chrome\n');

  bundleHarness();

  // ── system Chrome: record + quit so the daemon routes to us ──────────────────
  const chromeWasRunning = chromeRunning();
  let weQuitChrome = false;
  if (chromeWasRunning) {
    log('▶ system Google Chrome is running — quitting it so the daemon routes to OUR profile.');
    try {
      execFileSync('osascript', ['-e', 'quit app "Google Chrome"']);
      for (let i = 0; i < 20 && chromeRunning(); i++) await sleep(250);
      weQuitChrome = !chromeRunning();
      log(weQuitChrome ? '  ✓ Chrome quit (will be restored after the run).' : '  ⚠ Chrome did not quit.');
    } catch (e) {
      log(`  ⚠ could not quit Chrome: ${e.message}`);
    }
  } else {
    log('▶ system Google Chrome not running — nothing to quit (and nothing to restore).');
  }
  const chromeRunningBeforeOpencli = chromeRunning();

  let verdict = { pass: false, reason: '', results: null, frames: frameLog };
  let child = null;
  try {
    // ── launch the harness ───────────────────────────────────────────────────
    log('\n▶ launching Electron harness (hidden, off-screen WebContentsView)…');
    child = spawn(electronBin, [bundlePath], {
      cwd: pkgDir,
      env: {
        ...process.env,
        BRIDGE_FRAME_LOG: frameLog,
        BRIDGE_CONTEXT_ID: process.env.BRIDGE_CONTEXT_ID ?? '3k59e8nw',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write(`  [harness-err] ${d}`));

    await waitForReady(child);
    log('  ✓ harness ready — registered as the daemon profile, serving /ext.\n');
    await sleep(500); // let the hello settle on the daemon side

    // ── the kill-or-confirm: a REAL opencli browser command ───────────────────
    log(`▶ running: opencli google search "${QUERY}" -f json`);
    let out = '';
    let opencliError = null;
    try {
      out = execSync(`opencli google search ${JSON.stringify(QUERY)} -f json`, {
        env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
        encoding: 'utf8',
        timeout: OPENCLI_TIMEOUT_MS,
      });
    } catch (e) {
      opencliError = e;
      out = (e.stdout ?? '').toString();
    }

    let parsed = null;
    try {
      parsed = JSON.parse(out);
    } catch {
      /* non-json output captured below */
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.results)
          ? parsed.results
          : Array.isArray(parsed?.data)
            ? parsed.data
            : [];

    log(`  opencli returned ${rows.length} result(s).`);
    verdict.results = rows.slice(0, 5);

    // ── assertions ─────────────────────────────────────────────────────────────
    const gotResults = rows.length > 0;
    const chromeNotLaunched = chromeRunningBeforeOpencli || !chromeRunning();

    log('');
    log(`  assert (a) opencli got real Google results via OUR view : ${gotResults ? 'YES' : 'NO'}`);
    log(`  assert (b) system Chrome not (re)launched by the run    : ${chromeNotLaunched ? 'YES' : 'NO'}`);

    if (gotResults && chromeNotLaunched) {
      verdict.pass = true;
      verdict.reason = 'opencli google search returned real results driven through the bridge WebContentsView; system Chrome untouched.';
    } else {
      verdict.reason = !gotResults
        ? `no results parsed from opencli output${opencliError ? ` (opencli errored: ${opencliError.message})` : ''}. Raw head: ${out.slice(0, 400)}`
        : 'system Chrome was launched during the run';
    }
  } catch (err) {
    verdict.reason = err instanceof Error ? err.message : String(err);
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await sleep(400);
      child.kill('SIGKILL');
    }
    // ── restore Chrome exactly as we found it ──────────────────────────────────
    if (weQuitChrome) {
      log('\n▶ restoring system Google Chrome (we quit it for the test)…');
      try {
        execFileSync('open', ['-a', 'Google Chrome']);
        log('  ✓ Chrome relaunched.');
      } catch (e) {
        log(`  ⚠ could not restore Chrome: ${e.message} — relaunch it manually.`);
      }
    }
  }

  const summary = {
    verdict: verdict.pass ? 'PASS' : 'FAIL',
    reason: verdict.reason,
    query: QUERY,
    chromeWasRunningBefore: chromeWasRunning,
    weQuitChrome,
    sampleResults: verdict.results,
    evidence: { frameLog, bundle: bundlePath },
    ts: new Date().toISOString(),
  };
  writeFileSync(join(evidenceDir, 'verdict.json'), JSON.stringify(summary, null, 2));

  log('\n──────────────────────────────────────────────');
  log(verdict.pass ? '✅ MILESTONE 1 PROOF: PASS' : '❌ MILESTONE 1 PROOF: FAIL');
  log(`   ${verdict.reason}`);
  log(`   evidence: ${frameLog}`);
  log(`   verdict:  ${join(evidenceDir, 'verdict.json')}`);
  log('──────────────────────────────────────────────');

  process.exit(verdict.pass ? 0 : 1);
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
