// connectors-store — userData/connectors.json persistence. Pins the load-time
// hardening: stored-only sites get auto-probed (their keys reach opencli argv),
// so a tampered cache must not smuggle flag-like keys or transient statuses in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectorsStore } from '../src/main/connectors-store.ts';

const freshDir = () => mkdtempSync(join(tmpdir(), 'connectors-store-'));

test('round-trips stable records', () => {
  const dir = freshDir();
  const store = createConnectorsStore({ userDataDir: dir });
  store.save({ zhihu: { status: 'connected', account: 'drej', lastChecked: 5 } });
  assert.deepEqual(createConnectorsStore({ userDataDir: dir }).load(), {
    zhihu: { status: 'connected', account: 'drej', lastChecked: 5 },
  });
  const raw = JSON.parse(readFileSync(join(dir, 'connectors.json'), 'utf8'));
  assert.equal(raw.version, 1);
});

test('missing or corrupt cache loads as empty, never throws', () => {
  const dir = freshDir();
  assert.deepEqual(createConnectorsStore({ userDataDir: dir }).load(), {});
  writeFileSync(join(dir, 'connectors.json'), '{not json');
  assert.deepEqual(createConnectorsStore({ userDataDir: dir }).load(), {});
});

test('load drops flag-like site keys and non-stable statuses (tamper hardening)', () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, 'connectors.json'),
    JSON.stringify({
      version: 1,
      sites: {
        zhihu: { status: 'connected' },
        '--profile': { status: 'connected' }, // would smuggle a flag into argv
        '../evil': { status: 'connected' }, // path-shaped key
        dianping: { status: 'connecting' }, // transient must not persist back in
        12306: { status: 'disconnected' }, // numeric-looking key stays valid
      },
    }),
  );
  assert.deepEqual(createConnectorsStore({ userDataDir: dir }).load(), {
    zhihu: { status: 'connected' },
    '12306': { status: 'disconnected' },
  });
});
