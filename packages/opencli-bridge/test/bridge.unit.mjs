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
import { createSingleLeaseProvider } from '../src/lease.ts';
import { dispatch } from '../src/actions.ts';
import { ok, fail } from '../src/protocol.ts';
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
