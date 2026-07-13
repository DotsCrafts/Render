// render-adapter trusted half — the privilege boundary where agent-staged
// adapter code crosses into the unsandboxed opencli daemon. Pins:
//   • only <site>/<name>.js slugs land, under the clis dir, with backups;
//   • _shared (backs every auth adapter) is never writable through this path;
//   • path/flag-shaped targets, oversized and binary stages are rejected;
//   • the shim sentinel parses exactly (target + staged path + reason).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapterInstaller } from '../src/main/adapter-install.ts';
import { parseRenderAdapter, RENDER_ADAPTER_SENTINEL } from '../src/main/agent-instructions.ts';

const setup = () => {
  const clisDir = mkdtempSync(join(tmpdir(), 'clis-'));
  const stageDir = mkdtempSync(join(tmpdir(), 'staged-'));
  let clock = 1000;
  const installer = createAdapterInstaller({ clisDir, now: () => ++clock });
  const stage = (name, content) => {
    const p = join(stageDir, name);
    writeFileSync(p, content);
    return p;
  };
  return { clisDir, installer, stage };
};

test('install: writes <site>/<name>.js under the clis dir', () => {
  const { clisDir, installer, stage } = setup();
  const staged = stage('auth.js', 'export const ok = 1;\n');
  const res = installer.install('dianping/auth.js', staged);
  assert.equal(res.ok, true);
  assert.equal(res.replaced, false);
  assert.equal(readFileSync(join(clisDir, 'dianping', 'auth.js'), 'utf8'), 'export const ok = 1;\n');
});

test('install: replacing an existing override keeps a backup', () => {
  const { clisDir, installer, stage } = setup();
  installer.install('zhihu/hot.js', stage('v1.js', 'v1'));
  const res = installer.install('zhihu/hot.js', stage('v2.js', 'v2'));
  assert.equal(res.ok, true);
  assert.equal(res.replaced, true);
  assert.equal(readFileSync(join(clisDir, 'zhihu', 'hot.js'), 'utf8'), 'v2');
  const backups = readdirSync(join(clisDir, 'zhihu')).filter((f) => f.includes('.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(clisDir, 'zhihu', backups[0]), 'utf8'), 'v1');
});

test('install: rejects path/flag-shaped targets and _shared', () => {
  const { clisDir, installer, stage } = setup();
  const staged = stage('x.js', 'x');
  for (const target of [
    '../evil/auth.js',
    'site/../../evil.js',
    '--profile/auth.js',
    'site/auth.ts',
    'site/auth',
    '_shared/site-auth.js',
  ]) {
    const res = installer.install(target, staged);
    assert.equal(res.ok, false, `${target} must be rejected`);
  }
  assert.equal(existsSync(join(clisDir, '_shared')), false);
});

test('install: rejects missing, empty, oversized, and binary staged files', () => {
  const { installer, stage } = setup();
  assert.equal(installer.install('a/b.js', '/nope/none.js').ok, false);
  assert.equal(installer.install('a/b.js', stage('empty.js', '')).ok, false);
  assert.equal(installer.install('a/b.js', stage('big.js', 'x'.repeat(300 * 1024))).ok, false);
  assert.equal(installer.install('a/b.js', stage('bin.js', 'a\u0000b')).ok, false);
});

test('parseRenderAdapter: reads the shim sentinel with reason', () => {
  const out = `noise\n${RENDER_ADAPTER_SENTINEL}\tdianping/auth.js\t/work/staged/auth.js\tfix stale dper detection\ndone`;
  assert.deepEqual(parseRenderAdapter(out), {
    target: 'dianping/auth.js',
    stagedPath: '/work/staged/auth.js',
    reason: 'fix stale dper detection',
  });
  assert.equal(parseRenderAdapter('no sentinel here'), null);
  assert.equal(
    parseRenderAdapter(`${RENDER_ADAPTER_SENTINEL}\tsite/x.js\trelative/path.js\t`),
    null,
    'staged path must be absolute',
  );
});
