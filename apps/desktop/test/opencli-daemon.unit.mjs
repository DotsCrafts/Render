/**
 * Unit tests for ensureOpencliDaemon — regression for the cold-boot stall: a
 * MISSING opencli binary (spawn ENOENT) must short-circuit the reachability
 * poll instead of burning the full deadline (which used to hold the first
 * window for 15 seconds on machines without opencli installed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

const { ensureOpencliDaemon } = await import('../src/main/opencli-daemon.ts');

/** Grab an ephemeral port and release it — free (enough) for a negative probe. */
const getFreePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

test('missing opencli binary short-circuits the warmup poll', async () => {
  const port = await getFreePort();
  const started = Date.now();
  const ok = await ensureOpencliDaemon({
    bin: '/definitely/not/a/real/opencli-bin',
    port,
    timeoutMs: 8_000,
  });
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 4_000, 'returned well before the 8s deadline');
});

test('an already-reachable daemon returns true immediately', async () => {
  const srv = http.createServer((_req, res) => res.end('pong'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    assert.equal(await ensureOpencliDaemon({ port, timeoutMs: 3_000 }), true);
  } finally {
    srv.close();
  }
});
