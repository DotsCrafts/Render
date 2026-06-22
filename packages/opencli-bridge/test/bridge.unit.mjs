/**
 * Unit tests for the transport-independent bridge logic (no Electron, no daemon).
 *
 * Exercises the pieces the harness can't isolate: the single-lease semantics
 * (reuse + stale-page), the action dispatch over a FAKE CdpTarget, and the
 * protocol envelope shapes. Run with the repo's bundled tsx-free node:test:
 *
 *   node --import ./test/loader.mjs --test test/bridge.unit.mjs
 *
 * (The loader transpiles the TS sources on the fly via esbuild.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createSingleLeaseProvider } from '../src/lease.ts';
import { dispatch } from '../src/actions.ts';
import { ok, fail, RENDER_CONTEXT_ID, SYSTEM_CHROME_CONTEXT_ID } from '../src/protocol.ts';
import { createOpencliBridge } from '../src/bridge.ts';
import { StalePageError } from '../src/types.ts';

/** A fake CDP target: records sends, returns scripted Runtime.evaluate values. */
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
        // fire the load event the navigate handler waits on
        queueMicrotask(() => handlers.get('Page.frameStoppedLoading')?.forEach((cb) => cb({})));
        return { frameId: 'f1' };
      }
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        if (expr === 'document.title') return { result: { value: scripted.title ?? 'T' } };
        if (expr === 'location.href') return { result: { value: scripted.url ?? 'https://x' } };
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

test('single-lease: first acquire mints, second reuses the same target', async () => {
  let minted = 0;
  const provider = createSingleLeaseProvider({
    createTarget: async () => fakeTarget(`t${++minted}`),
  });
  const a = await provider.acquire();
  const b = await provider.acquire();
  assert.equal(a, b);
  assert.equal(minted, 1);
  // reusing by the correct page handle returns the same lease
  const c = await provider.acquire(a.targetId);
  assert.equal(c, a);
});

test('single-lease: unknown page handle is a stale-page error', async () => {
  const provider = createSingleLeaseProvider({ createTarget: async () => fakeTarget('t1') });
  await provider.acquire();
  await assert.rejects(() => provider.acquire('NOT-THE-LEASE'), StalePageError);
});

test('navigate → echoes a stable page + title/url; exec → raw value', async () => {
  const target = fakeTarget('PAGE1', { title: 'Hello', url: 'https://e.com', exec: { items: [1, 2] } });
  const provider = createSingleLeaseProvider({ createTarget: async () => target });

  const nav = await dispatch(provider, { id: 'n1', action: 'navigate', url: 'https://e.com' });
  assert.equal(nav.ok, true);
  assert.equal(nav.page, 'PAGE1');
  assert.deepEqual(nav.data, { title: 'Hello', url: 'https://e.com', timedOut: false });

  const ex = await dispatch(provider, { id: 'e1', action: 'exec', code: 'scrape()', page: 'PAGE1' });
  assert.equal(ex.ok, true);
  assert.deepEqual(ex.data, { items: [1, 2] });
  assert.equal(ex.page, 'PAGE1');
});

test('navigate rejects non-http schemes', async () => {
  const provider = createSingleLeaseProvider({ createTarget: async () => fakeTarget('t1') });
  const r = await dispatch(provider, { id: 'x', action: 'navigate', url: 'file:///etc/passwd' });
  assert.equal(r.ok, false);
});

test('close-window disposes the lease; stubs fail loudly; unknown action fails', async () => {
  const target = fakeTarget('t1');
  const provider = createSingleLeaseProvider({ createTarget: async () => target });
  await provider.acquire();
  const close = await dispatch(provider, { id: 'c1', action: 'close-window' });
  assert.deepEqual(close, ok('c1', { closed: true }));
  assert.equal(target.isAlive(), false);

  const stub = await dispatch(provider, { id: 's1', action: 'screenshot' });
  assert.equal(stub.ok, false);
  assert.equal(stub.errorCode, 'not_implemented');

  const unknown = await dispatch(provider, { id: 'u1', action: 'frobnicate' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errorCode, 'unknown_action');
});

test('protocol envelopes are immutable shapes', () => {
  assert.deepEqual(ok('1', 42, 'P'), { id: '1', ok: true, data: 42, page: 'P' });
  assert.deepEqual(ok('1', 42), { id: '1', ok: true, data: 42 });
  assert.deepEqual(fail('1', 'boom', { errorCode: 'x' }), {
    id: '1',
    ok: false,
    error: 'boom',
    errorCode: 'x',
  });
});

// ── M1.5: distinct profile identity + clean disconnect ───────────────────────

test('protocol: Render registers as its OWN contextId, NOT the system-Chrome one', () => {
  // The whole M1.5 fix: our default contextId must differ from system Chrome's,
  // so the daemon does not evict Chrome's socket (collision == the M1 quit-Chrome bug).
  assert.equal(RENDER_CONTEXT_ID, 'render');
  assert.notEqual(RENDER_CONTEXT_ID, SYSTEM_CHROME_CONTEXT_ID);
});

/**
 * A minimal stand-in for the opencli daemon's `/ext` WS server that mirrors the
 * two behaviours we depend on (verified against daemon.js):
 *   • on `hello`, register the socket under `contextId`, evicting any PRIOR socket
 *     on the SAME contextId (registerExtensionConnection),
 *   • on socket close, unregister that contextId (unregisterExtensionConnection).
 * `profiles()` returns the live set the CLI would resolve against.
 */
function fakeDaemon() {
  const byContext = new Map(); // contextId -> ws
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    let myContextId = null;
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        const cid = (typeof msg.contextId === 'string' && msg.contextId.trim()) || 'default';
        const prior = byContext.get(cid);
        if (prior && prior !== ws) prior.close(); // evict prior socket on same id
        myContextId = cid;
        byContext.set(cid, ws);
      }
    });
    ws.on('close', () => {
      if (myContextId && byContext.get(myContextId) === ws) byContext.delete(myContextId);
    });
  });
  return {
    url: () => `ws://127.0.0.1:${wss.address().port}/ext`,
    profiles: () => [...byContext.keys()].sort(),
    close: () => new Promise((r) => wss.close(r)),
  };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const noopProvider = () => ({ acquire: async () => fakeTarget('t'), current: () => null, dispose: async () => {} });

test('bridge connects as a DISTINCT default profile (render), coexisting with system Chrome', async () => {
  const daemon = fakeDaemon();
  // simulate system Chrome's extension already connected on its own contextId
  const { WebSocket } = await import('ws');
  const chrome = new WebSocket(daemon.url());
  await new Promise((r) => chrome.on('open', r));
  chrome.send(JSON.stringify({ type: 'hello', contextId: SYSTEM_CHROME_CONTEXT_ID }));
  await settle();
  assert.deepEqual(daemon.profiles(), [SYSTEM_CHROME_CONTEXT_ID]);

  // bring up the bridge with its DEFAULT contextId — must NOT evict Chrome
  const bridge = createOpencliBridge({ provider: noopProvider(), daemonUrl: daemon.url(), autoReconnect: false });
  await bridge.start();
  await settle();
  assert.deepEqual(daemon.profiles(), [SYSTEM_CHROME_CONTEXT_ID, RENDER_CONTEXT_ID].sort());
  assert.ok(chrome.readyState === WebSocket.OPEN, 'system Chrome socket must stay open (never evicted)');

  await bridge.stop();
  chrome.close();
  await daemon.close();
});

test('stop() leaves the daemon CLEAN — our profile is unregistered, no ghost', async () => {
  const daemon = fakeDaemon();
  const bridge = createOpencliBridge({
    provider: noopProvider(),
    daemonUrl: daemon.url(),
    contextId: 'render',
    autoReconnect: false,
  });
  await bridge.start();
  await settle();
  assert.deepEqual(daemon.profiles(), ['render']);

  await bridge.stop(); // must AWAIT the socket close so the daemon unregisters us
  await settle();
  assert.equal(bridge.connected, false);
  assert.deepEqual(daemon.profiles(), [], 'no ghost profile may remain after stop()');

  await daemon.close();
});

test('a configured contextId is what gets registered (routing target is controllable)', async () => {
  const daemon = fakeDaemon();
  const bridge = createOpencliBridge({
    provider: noopProvider(),
    daemonUrl: daemon.url(),
    contextId: 'render-test-7',
    autoReconnect: false,
  });
  await bridge.start();
  await settle();
  assert.deepEqual(daemon.profiles(), ['render-test-7']);
  await bridge.stop();
  await daemon.close();
});
