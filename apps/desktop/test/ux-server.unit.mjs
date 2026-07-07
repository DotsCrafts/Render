/**
 * Unit tests for the ux-server child watcher — regressions for:
 *   - the stdout scanner that re-parsed the text before the FIRST newline
 *     forever (a banner line before the JSON announce wedged readiness),
 *   - the missing ready deadline (a child that never announces suspended
 *     deliverPage/openPage callers permanently),
 *   - stderrTail (callers can now surface WHY a page failed),
 *   - temp spec-file cleanup on dispose.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'fake-ux.mjs');
process.env.RENDER_PORTAL_UX_MJS = FIXTURE;

const { serveUxSpec, resolveUxMjs } = await import('../src/main/ux-server.ts');

test('resolveUxMjs honors the env override', () => {
  assert.equal(resolveUxMjs(), FIXTURE);
});

test('scanner skips a banner line and still finds the JSON announce', async () => {
  const idTag = `t-banner-${Date.now()}`;
  const page = serveUxSpec({
    specJson: JSON.stringify({ mode: 'banner-then-announce', url: 'http://127.0.0.1:60000/x' }),
    allow: '',
    idTag,
  });
  const url = await page.whenReady();
  assert.equal(url, 'http://127.0.0.1:60000/x');
  assert.equal(page.url, url);

  const specFile = join(tmpdir(), `render-page-${idTag}.json`);
  assert.ok(existsSync(specFile), 'spec file exists while the server runs');
  page.dispose();
  assert.ok(!existsSync(specFile), 'dispose unlinks the temp spec file');
});

test('early exit resolves null and keeps a stderr tail', async () => {
  const page = serveUxSpec({
    specJson: JSON.stringify({ mode: 'exit-with-stderr' }),
    allow: '',
    idTag: `t-exit-${Date.now()}`,
  });
  assert.equal(await page.whenReady(), null);
  assert.match(page.stderrTail(), /kernel exploded/);
  page.dispose();
});

test('a server that never announces hits the ready deadline', async () => {
  const started = Date.now();
  const page = serveUxSpec({
    specJson: JSON.stringify({ mode: 'never-announce' }),
    allow: '',
    idTag: `t-hang-${Date.now()}`,
    readyTimeoutMs: 500,
  });
  assert.equal(await page.whenReady(), null);
  assert.ok(Date.now() - started < 5_000, 'resolved by the deadline, not never');
  page.dispose();
});

test('missing kernel yields the DISABLED page (null url, empty tail)', async () => {
  process.env.RENDER_PORTAL_UX_MJS = join(__dirname, 'fixtures', 'does-not-exist.mjs');
  try {
    const page = serveUxSpec({ specJson: '{}', allow: '', idTag: `t-miss-${Date.now()}` });
    assert.equal(await page.whenReady(), null);
    assert.equal(page.stderrTail(), '');
    page.dispose();
  } finally {
    process.env.RENDER_PORTAL_UX_MJS = FIXTURE;
  }
});
