/**
 * Unit tests for per-session lease partitioning + dispatch lanes (no Electron,
 * no daemon — same fake-target approach as bridge.unit.mjs).
 *
 * Covers the two audited findings:
 *   • "close-window-nukes-all-leases" — close-window must release ONLY the
 *     calling session's leases (bridge.stop() still tears down everything).
 *   • "ux-data-fifo-waterfall" — commands from different sessions must not
 *     queue behind each other; lease-mutating ops keep a global exclusive lane.
 *
 * The load-bearing property: two concurrent opencli sessions can NEITHER
 * destroy NOR hijack each other's tabs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import {
  createSessionLeaseRegistry,
  getLeaseKey,
  leaseKeyForCommand,
  IDLE_TIMEOUT_DEFAULT,
  IDLE_TIMEOUT_INTERACTIVE,
} from '../src/session-registry.ts';
import { createDispatchLanes } from '../src/dispatch-lanes.ts';
import { dispatch } from '../src/actions.ts';
import { createOpencliBridge } from '../src/bridge.ts';
import { StalePageError } from '../src/types.ts';

/** A fake CDP target (same shape as bridge.unit.mjs), plus scripted exec delay/hang. */
function fakeTarget(id, scripted = {}) {
  const sent = [];
  let alive = true;
  const handlers = new Map();
  return {
    targetId: id,
    sent,
    isAlive: () => alive,
    attach: async () => {},
    close: async () => {
      alive = false;
    },
    send: async (method, params) => {
      sent.push({ method, params });
      if (method === 'Page.navigate') {
        queueMicrotask(() => handlers.get('Page.frameStoppedLoading')?.forEach((cb) => cb({})));
        return { frameId: 'f1' };
      }
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        if (expr === 'document.title') return { result: { value: scripted.title ?? 'T' } };
        if (expr === 'location.href') return { result: { value: scripted.url ?? 'https://x' } };
        if (scripted.hangExec) return new Promise(() => {}); // never resolves
        if (scripted.execDelayMs) await new Promise((r) => setTimeout(r, scripted.execDelayMs));
        return { result: { value: scripted.exec ?? 'ok' } };
      }
      return {};
    },
    on: (event, cb) => {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    },
  };
}

/** Mirror the bridge's routing: resolve the command's partition, then dispatch. */
const run = (registry, cmd, caps = {}) => dispatch(registry.providerFor(cmd), cmd, caps);

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ── leaseKey (extension getLeaseKey parity) ───────────────────────────────────

test('leaseKey mirrors the extension: surface\\0encodeURIComponent(session)', () => {
  assert.equal(getLeaseKey('run-1', 'adapter'), 'adapter\0run-1');
  assert.equal(getLeaseKey('a b/c', 'browser'), 'browser\0a%20b%2Fc');
  // any surface that is not `adapter` normalizes to `browser` (getCommandSurface)
  assert.equal(getLeaseKey('s', undefined), 'browser\0s');
  assert.equal(getLeaseKey('s', 'weird'), 'browser\0s');
  // no/blank session → the surface's DEFAULT partition (empty session part);
  // encodeURIComponent of a real session is never empty, so no collision.
  assert.equal(getLeaseKey(undefined, 'browser'), 'browser\0');
  assert.equal(getLeaseKey('   ', 'browser'), 'browser\0');
  assert.equal(leaseKeyForCommand({ session: 'x', surface: 'adapter' }), 'adapter\0x');
  // extension idle defaults are what we ship
  assert.equal(IDLE_TIMEOUT_DEFAULT, 30_000);
  assert.equal(IDLE_TIMEOUT_INTERACTIVE, 600_000);
});

// ── isolation: two concurrent sessions ───────────────────────────────────────

test('two sessions cannot HIJACK each other: page handles are session-scoped', async () => {
  const minted = [];
  const registry = createSessionLeaseRegistry({
    createTarget: async () => {
      const t = fakeTarget(`PAGE${minted.length + 1}`, { exec: `from-${minted.length + 1}` });
      minted.push(t);
      return t;
    },
  });
  const A = { session: 'sess-a', surface: 'adapter' };
  const B = { session: 'sess-b', surface: 'adapter' };

  const a1 = await run(registry, { id: 'a1', action: 'tabs', op: 'new', ...A });
  const b1 = await run(registry, { id: 'b1', action: 'tabs', op: 'new', ...B });
  assert.equal(a1.page, 'PAGE1');
  assert.equal(b1.page, 'PAGE2');
  assert.deepEqual(registry.sessions().sort(), ['adapter\0sess-a', 'adapter\0sess-b']);

  // B tries to exec against A's page handle → stale in B's partition, and the
  // command never reaches A's target.
  await assert.rejects(
    () => run(registry, { id: 'steal', action: 'exec', code: 'steal()', page: a1.page, ...B }),
    StalePageError,
  );
  assert.equal(minted[0].sent.filter((s) => s.method === 'Runtime.evaluate').length, 0);

  // each session's exec lands on its OWN target
  const ea = await run(registry, { id: 'ea', action: 'exec', code: 'x', page: a1.page, ...A });
  const eb = await run(registry, { id: 'eb', action: 'exec', code: 'x', page: b1.page, ...B });
  assert.equal(ea.data, 'from-1');
  assert.equal(eb.data, 'from-2');

  // tabs list is partitioned: each session sees only its own tab
  const la = await run(registry, { id: 'la', action: 'tabs', op: 'list', ...A });
  const lb = await run(registry, { id: 'lb', action: 'tabs', op: 'list', ...B });
  assert.deepEqual(la.data.map((t) => t.page), ['PAGE1']);
  assert.deepEqual(lb.data.map((t) => t.page), ['PAGE2']);
});

test('two sessions cannot DESTROY each other: tabs close + close-window are session-local', async () => {
  const minted = [];
  const registry = createSessionLeaseRegistry({
    createTarget: async () => {
      const t = fakeTarget(`PAGE${minted.length + 1}`);
      minted.push(t);
      return t;
    },
  });
  const A = { session: 'sess-a', surface: 'adapter' };
  const B = { session: 'sess-b', surface: 'adapter' };
  const a1 = await run(registry, { id: 'a1', action: 'tabs', op: 'new', ...A });
  await run(registry, { id: 'b1', action: 'tabs', op: 'new', ...B });
  const [ta, tb] = minted;

  // B closes with A's page handle → no-op in B's partition; A's tab survives
  const close = await run(registry, { id: 'c1', action: 'tabs', op: 'close', page: a1.page, ...B });
  assert.equal(close.ok, true);
  assert.equal(close.data.closed, undefined);
  assert.equal(ta.isAlive(), true, "A's tab must survive B's close attempt");

  // the audited finding: B's close-window releases ONLY B's leases
  const cw = await run(registry, { id: 'cw', action: 'close-window', ...B });
  assert.deepEqual(cw.data, { closed: true });
  assert.equal(tb.isAlive(), false, "B's own tab is released");
  assert.equal(ta.isAlive(), true, "A's tab must survive B's close-window");
  assert.deepEqual(registry.sessions(), ['adapter\0sess-a']);

  // A keeps working after B is gone
  const ea = await run(registry, { id: 'ea', action: 'exec', code: 'x', page: a1.page, ...A });
  assert.equal(ea.ok, true);

  // bridge.stop() path: registry.dispose() tears down EVERYTHING left
  await registry.dispose();
  assert.equal(ta.isAlive(), false);
  assert.deepEqual(registry.sessions(), []);
});

test("pageless acquire resolves against the command's OWN session, minting lazily", async () => {
  let mintCount = 0;
  const registry = createSessionLeaseRegistry({
    createTarget: async () => fakeTarget(`PAGE${++mintCount}`),
  });
  const A = { session: 'sess-a', surface: 'adapter' };
  const B = { session: 'sess-b', surface: 'adapter' };

  // A's first pageless navigate mints A's lease…
  const n1 = await run(registry, { id: 'n1', action: 'navigate', url: 'https://a', ...A });
  // …and B's pageless navigate mints its OWN — it must NOT reuse A's active lease
  const n2 = await run(registry, { id: 'n2', action: 'navigate', url: 'https://b', ...B });
  assert.equal(n1.page, 'PAGE1');
  assert.equal(n2.page, 'PAGE2');
  assert.notEqual(n1.page, n2.page, 'a pageless command must never land on another session');

  // a later pageless command in A reuses A's lease (no extra mint)
  const n3 = await run(registry, { id: 'n3', action: 'navigate', url: 'https://a/2', ...A });
  assert.equal(n3.page, 'PAGE1');
  assert.equal(mintCount, 2);
});

test('sessionless commands route to a dedicated default partition', async () => {
  let mintCount = 0;
  const registry = createSessionLeaseRegistry({
    createTarget: async () => fakeTarget(`PAGE${++mintCount}`),
  });
  const A = { session: 'sess-a', surface: 'browser' };

  const a1 = await run(registry, { id: 'a1', action: 'tabs', op: 'new', ...A });
  const d1 = await run(registry, { id: 'd1', action: 'tabs', op: 'new' }); // no session/surface
  assert.notEqual(d1.page, a1.page);
  assert.deepEqual(registry.sessions().sort(), ['browser\0', 'browser\0sess-a']);

  // sessionless close-window nukes ONLY the default partition
  await run(registry, { id: 'cw', action: 'close-window' });
  assert.deepEqual(registry.sessions(), ['browser\0sess-a']);
  const ea = await run(registry, { id: 'ea', action: 'exec', code: 'x', page: a1.page, ...A });
  assert.equal(ea.ok, true, "a session's lease must survive a sessionless close-window");
});

// ── idle reaping ──────────────────────────────────────────────────────────────

test("idle timeout reaps ONLY the idle session's leases (cmd.idleTimeout override)", async () => {
  const minted = [];
  const released = [];
  const registry = createSessionLeaseRegistry({
    createTarget: async () => {
      const t = fakeTarget(`PAGE${minted.length + 1}`);
      minted.push(t);
      return t;
    },
    onRelease: (key, reason) => released.push({ key, reason }),
  });
  // A opts into a 0.05 s idle timeout (extension: idleTimeout seconds → ms);
  // B has the browser-surface default (10 min) and must be untouched.
  await run(registry, {
    id: 'a1', action: 'tabs', op: 'new', session: 'sess-a', surface: 'adapter', idleTimeout: 0.05,
  });
  await run(registry, {
    id: 'b1', action: 'tabs', op: 'new', session: 'sess-b', surface: 'browser',
  });
  const [ta, tb] = minted;

  await settle(120);
  assert.equal(ta.isAlive(), false, "idle session's tab must be reaped");
  assert.equal(tb.isAlive(), true, 'the other session must be untouched');
  assert.deepEqual(registry.sessions(), ['browser\0sess-b']);
  assert.deepEqual(released, [{ key: 'adapter\0sess-a', reason: 'idle timeout' }]);

  // a fresh command for the reaped session simply re-mints (no stale state)
  const n = await run(registry, {
    id: 'n', action: 'navigate', url: 'https://a', session: 'sess-a', surface: 'adapter',
  });
  assert.equal(n.ok, true);
  assert.equal(n.page, 'PAGE3');
  await registry.dispose();
});

test('activity resets the idle timer; adapter siteSession=persistent never reaps', async () => {
  const minted = [];
  const registry = createSessionLeaseRegistry({
    createTarget: async () => {
      const t = fakeTarget(`PAGE${minted.length + 1}`);
      minted.push(t);
      return t;
    },
  });
  const A = { session: 'sess-a', surface: 'adapter', idleTimeout: 0.2 };
  await run(registry, { id: 'a1', action: 'tabs', op: 'new', ...A });
  // touch inside the window → deadline slides
  await settle(120);
  registry.touch(A);
  await settle(120);
  assert.equal(minted[0].isAlive(), true, 'activity must reset the idle timer');
  await settle(180);
  assert.equal(minted[0].isAlive(), false, 'quiet past the timeout → reaped');

  // persistent adapter session: never reaped, even with time to spare
  const P = { session: 'sess-p', surface: 'adapter', siteSession: 'persistent', idleTimeout: 0.05 };
  await run(registry, { id: 'p1', action: 'tabs', op: 'new', ...P });
  await settle(150);
  assert.equal(minted[1].isAlive(), true, 'persistent adapter sessions must not idle out');
  await registry.dispose();
});

// ── dispatch lanes ────────────────────────────────────────────────────────────

test('lanes: sessions run concurrently; each lane stays FIFO; errors never wedge a lane', async () => {
  const lanes = createDispatchLanes();
  const order = [];
  let releaseA;
  const gateA = new Promise((r) => (releaseA = r));

  const pA1 = lanes.enqueue('A', false, async () => {
    await gateA;
    order.push('a1');
  });
  const pA2 = lanes.enqueue('A', false, async () => order.push('a2'));
  const pB1 = lanes.enqueue('B', false, async () => order.push('b1'));

  await pB1;
  assert.deepEqual(order, ['b1'], "B must NOT wait behind A's stalled lane (the fifo waterfall)");
  releaseA();
  await Promise.all([pA1, pA2]);
  assert.deepEqual(order, ['b1', 'a1', 'a2'], "A's own lane preserves FIFO order");

  // a rejecting command surfaces to its caller but the lane keeps moving
  await assert.rejects(lanes.enqueue('A', false, async () => { throw new Error('boom'); }));
  assert.equal(await lanes.enqueue('A', false, async () => 'still-alive'), 'still-alive');
});

test('lanes: an exclusive op is a global barrier (waits for all, blocks all)', async () => {
  const lanes = createDispatchLanes();
  const order = [];
  let releaseA, releaseX;
  const gateA = new Promise((r) => (releaseA = r));
  const gateX = new Promise((r) => (releaseX = r));

  const pA = lanes.enqueue('A', false, async () => {
    await gateA;
    order.push('a');
  });
  const pX = lanes.enqueue('A', true, async () => {
    await gateX;
    order.push('x');
  });
  const pB = lanes.enqueue('B', false, async () => order.push('b'));

  await settle();
  assert.deepEqual(order, [], 'exclusive waits for in-flight lanes; later work waits for it');
  releaseA();
  await pA;
  await settle();
  assert.deepEqual(order, ['a'], 'the barrier itself is still gated');
  releaseX();
  await Promise.all([pX, pB]);
  assert.deepEqual(order, ['a', 'x', 'b']);
});

// ── bridge end-to-end: lanes + partitioning + deadline over the wire ─────────

/**
 * A fake daemon that FORWARDS command frames to the registered socket and
 * collects Result frames (extends bridge.unit.mjs's fakeDaemon with the
 * command path so lane behaviour is observable on the wire).
 */
function fakeCommandDaemon() {
  const wss = new WebSocketServer({ port: 0 });
  let socket = null;
  const results = [];
  const waiters = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') {
        socket = ws;
        return;
      }
      results.push(msg);
      waiters.splice(0).forEach((w) => w());
    });
  });
  return {
    url: () => `ws://127.0.0.1:${wss.address().port}/ext`,
    ready: async () => {
      while (!socket) await settle(10);
    },
    send: (cmd) => socket.send(JSON.stringify(cmd)),
    results,
    resultOf: async (id) => {
      for (;;) {
        const hit = results.find((r) => r.id === id);
        if (hit) return hit;
        await new Promise((r) => waiters.push(r));
      }
    },
    close: () => new Promise((r) => wss.close(r)),
  };
}

test('bridge: a slow session does not stall another; close-window stays session-local on the wire', async () => {
  const minted = [];
  const registry = createSessionLeaseRegistry({
    createTarget: async () => {
      // session A's target (first mint) is slow to exec; B's is instant
      const t = fakeTarget(`PAGE${minted.length + 1}`, {
        execDelayMs: minted.length === 0 ? 200 : 0,
      });
      minted.push(t);
      return t;
    },
  });
  const daemon = fakeCommandDaemon();
  const bridge = createOpencliBridge({
    provider: registry,
    daemonUrl: daemon.url(),
    autoReconnect: false,
  });
  await bridge.start();
  await daemon.ready();

  // mint one tab per session (exclusive ops — globally serialized)
  daemon.send({ id: 'a-new', action: 'tabs', op: 'new', session: 'A', surface: 'adapter' });
  daemon.send({ id: 'b-new', action: 'tabs', op: 'new', session: 'B', surface: 'adapter' });
  const aNew = await daemon.resultOf('a-new');
  const bNew = await daemon.resultOf('b-new');
  assert.notEqual(aNew.page, bNew.page);

  // A's slow exec first, then B's fast exec: B must answer while A is in flight
  daemon.send({ id: 'a-exec', action: 'exec', code: 'slow()', page: aNew.page, session: 'A', surface: 'adapter' });
  daemon.send({ id: 'b-exec', action: 'exec', code: 'fast()', page: bNew.page, session: 'B', surface: 'adapter' });
  const bExec = await daemon.resultOf('b-exec');
  assert.equal(bExec.ok, true);
  assert.equal(
    daemon.results.some((r) => r.id === 'a-exec'),
    false,
    "B's result must arrive while A's slow exec is still in flight (no fifo waterfall)",
  );
  const aExec = await daemon.resultOf('a-exec');
  assert.equal(aExec.ok, true);

  // B's close-window over the wire releases only B's tab
  daemon.send({ id: 'b-close', action: 'close-window', session: 'B', surface: 'adapter' });
  const bClose = await daemon.resultOf('b-close');
  assert.equal(bClose.ok, true);
  assert.equal(minted[1].isAlive(), false);
  assert.equal(minted[0].isAlive(), true, "A's tab must survive B's close-window");

  // bridge.stop() is still the dispose-ALL path
  await bridge.stop();
  assert.equal(minted[0].isAlive(), false, 'stop() must dispose every remaining lease');
  await daemon.close();
});

test('bridge: the dispatch deadline answers a hung command and frees its lane', async () => {
  let mintCount = 0;
  const registry = createSessionLeaseRegistry({
    // every exec on this target hangs forever
    createTarget: async () => fakeTarget(`PAGE${++mintCount}`, { hangExec: true }),
  });
  const daemon = fakeCommandDaemon();
  const bridge = createOpencliBridge({
    provider: registry,
    daemonUrl: daemon.url(),
    autoReconnect: false,
    dispatchDeadlineMs: 80, // stand-in for the production 45 s bound
  });
  await bridge.start();
  await daemon.ready();

  daemon.send({ id: 'a-new', action: 'tabs', op: 'new', session: 'A', surface: 'adapter' });
  const aNew = await daemon.resultOf('a-new');

  daemon.send({ id: 'hung', action: 'exec', code: 'HANG', page: aNew.page, session: 'A', surface: 'adapter' });
  const hung = await daemon.resultOf('hung');
  assert.equal(hung.ok, false);
  assert.equal(hung.errorCode, 'dispatch_deadline');

  // the SAME session's lane is free again — a follow-up command completes
  daemon.send({ id: 'after', action: 'tabs', op: 'list', session: 'A', surface: 'adapter' });
  const after = await daemon.resultOf('after');
  assert.equal(after.ok, true, 'a hung dispatch must not wedge the lane');

  await bridge.stop();
  await daemon.close();
});
