/**
 * Milestone-2 proof runner: exercises cdp/cookies/screenshot/frames against
 * Render's OWN WebContentsView over real CDP, with PAYLOAD assertions, while an
 * INDEPENDENT `pgrep -x "Google Chrome"` sampler proves system Chrome was never
 * touched.
 *
 * ⛔ This runner has NO opencli call, NO Chrome-driving code, and NO quit path.
 * It only drives Render's own off-screen WebContentsView (via harness-m2.ts) and
 * its own local 127.0.0.1 fixtures.
 *
 *   node harness/run-proof-m2.mjs    (from packages/opencli-bridge)
 */

import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..');
const evidenceDir = join(__dirname, 'evidence', 'm2');
const bundlePath = join(evidenceDir, 'harness-m2.bundle.mjs');

const READY_TIMEOUT_MS = 60_000;
const PGREP_INTERVAL_MS = 250;
const log = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const electronBin = (() => {
  const r = createRequire(join(pkgDir, '..', '..', 'apps', 'desktop', 'package.json'));
  return r('electron');
})();

/** system Chrome PID, or null — independent of opencli/daemon. Read-only probe. */
const chromePid = () => {
  try {
    return execSync('pgrep -x "Google Chrome"', { encoding: 'utf8' }).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
};

function bundle() {
  log('▶ bundling harness-m2.ts (esbuild, electron external)…');
  const esbuild = require('esbuild');
  esbuild.buildSync({
    entryPoints: [join(__dirname, 'harness-m2.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundlePath,
    external: ['electron'],
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  });
}

async function main() {
  mkdirSync(evidenceDir, { recursive: true });
  log('▶ opencli-bridge Milestone-2 ACTION proof — cdp/cookies/screenshot/frames');
  log('  over Render\'s OWN WebContentsView (real CDP). System Chrome is NEVER touched.\n');

  bundle();

  const chromePidBefore = chromePid();
  log(`▶ system Chrome PID before: ${chromePidBefore ?? '(not running)'} — we will NOT touch it.\n`);

  const timeline = [];
  let samplerActive = true;
  const samplerLoop = (async () => {
    while (samplerActive) {
      timeline.push({ ts: new Date().toISOString(), pid: chromePid() });
      await sleep(PGREP_INTERVAL_MS);
    }
  })();

  let harnessVerdict = null;
  let child = null;
  try {
    log('▶ launching Electron harness (hidden, off-screen WebContentsView)…');
    child = spawn(electronBin, [bundlePath], {
      cwd: pkgDir,
      env: { ...process.env, M2_EVIDENCE_DIR: evidenceDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      process.stdout.write(`  [harness] ${d.toString().replace(/\n$/, '')}\n`);
    });
    child.stderr.on('data', (d) => process.stderr.write(`  [harness-err] ${d}`));

    const exitCode = await Promise.race([
      new Promise((r) => child.on('exit', r)),
      sleep(READY_TIMEOUT_MS).then(() => 'TIMEOUT'),
    ]);
    if (exitCode === 'TIMEOUT') {
      try { child.kill('SIGKILL'); } catch { /* */ }
    }
    const m = out.match(/__M2_VERDICT__ (.+)/);
    if (m) harnessVerdict = JSON.parse(m[1]);
  } finally {
    samplerActive = false;
    await samplerLoop;
    if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* */ } }
  }

  // ── Chrome-alive evaluation (independent of the harness) ──────────────────────
  const chromePidAfter = chromePid();
  const everAbsent = timeline.some((s) => s.pid === null);
  const stable = timeline.every((s) => s.pid === null || s.pid === chromePidBefore);
  const chromeUntouched =
    chromePidBefore === null
      ? everAbsent === false // (Chrome wasn't running; it must STILL not be — we never launch it)
      : !everAbsent && stable && chromePidAfter === chromePidBefore;

  const actionsPass = harnessVerdict?.verdict === 'PASS';
  const verdict = actionsPass && chromeUntouched ? 'PASS' : actionsPass ? 'PARTIAL' : 'FAIL';

  const summary = {
    verdict,
    actionsPass,
    chromeUntouched,
    chromePidBefore,
    chromePidAfter,
    chromeSamples: timeline.length,
    chromePidTimeline: timeline,
    harness: harnessVerdict,
    evidence: { dir: evidenceDir, screenshot: join(evidenceDir, 'screenshot.png'), verdict: join(evidenceDir, 'verdict.json') },
    ts: new Date().toISOString(),
  };
  writeFileSync(join(evidenceDir, 'run-summary.json'), JSON.stringify(summary, null, 2));

  log('\n  ── assertions ─────────────────────────────────────────────');
  for (const s of harnessVerdict?.steps ?? []) log(`  ${s.pass ? '✓' : '✗'} ${s.name}`);
  log(`  ${chromeUntouched ? '✓' : '✗'} system Chrome untouched (pid ${chromePidBefore} → ${chromePidAfter}, ${timeline.length} samples, everAbsent=${everAbsent})`);
  log('\n──────────────────────────────────────────────');
  log(verdict === 'PASS' ? '✅ MILESTONE 2 ACTION PROOF: PASS' : `⚠️  MILESTONE 2 ACTION PROOF: ${verdict}`);
  log(`   evidence: ${evidenceDir}`);
  log('──────────────────────────────────────────────');
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
