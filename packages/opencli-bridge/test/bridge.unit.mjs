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
import { createMultiLeaseProvider } from '../src/multi-lease.ts';
import { createNetworkCaptureRegistry } from '../src/network-capture.ts';
import { dispatch, CDP_ALLOWLIST } from '../src/actions.ts';
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
      if (method === 'Page.captureScreenshot') return { data: scripted.screenshot ?? 'QkFTRTY0' };
      if (method === 'Network.getCookies') return { cookies: scripted.cookies ?? [] };
      if (method === 'Page.getFrameTree') return scripted.frameTree ?? { frameTree: { frame: { id: 'root', url: 'https://x' } } };
      if (scripted.cdp && scripted.cdp[method] !== undefined) return scripted.cdp[method];
      return {};
    },
    on: (event, cb) => {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    },
    /** test helper: fire a CDP event to subscribers (not part of CdpTarget). */
    emit: (event, params) => handlers.get(event)?.forEach((cb) => cb(params)),
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

  const unknown = await dispatch(provider, { id: 'u1', action: 'frobnicate' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errorCode, 'unknown_action');
});

test('single-lease provider: multi-lease actions fail loudly (no tabs/capture surface)', async () => {
  const provider = createSingleLeaseProvider({ createTarget: async () => fakeTarget('t1') });
  // tabs needs a multi-lease provider
  const tabs = await dispatch(provider, { id: 'tabs', action: 'tabs', op: 'list' });
  assert.equal(tabs.ok, false);
  assert.equal(tabs.errorCode, 'not_implemented');
  // capture without a registry → client-classified "unsupported"
  const cap = await dispatch(provider, { id: 'cap', action: 'network-capture-start' });
  assert.equal(cap.ok, false);
  assert.equal(cap.errorCode, 'unknown_action');
  // wait-download without download config
  const dl = await dispatch(provider, { id: 'dl', action: 'wait-download' });
  assert.equal(dl.ok, false);
  assert.equal(dl.errorCode, 'not_implemented');
});

// ── M3: multi-lease provider semantics ───────────────────────────────────────

test('multi-lease: tabs new ×2 mints DISTINCT stable targetIds; list shows both', async () => {
  let n = 0;
  const provider = createMultiLeaseProvider({ createTarget: async () => fakeTarget(`PAGE${++n}`) });

  const a = await dispatch(provider, { id: 't1', action: 'tabs', op: 'new' });
  const b = await dispatch(provider, { id: 't2', action: 'tabs', op: 'new' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.page, 'PAGE1');
  assert.equal(b.page, 'PAGE2');
  assert.notEqual(a.page, b.page, 'each new tab must have a distinct page handle');

  const list = await dispatch(provider, { id: 't3', action: 'tabs', op: 'list' });
  assert.equal(list.ok, true);
  assert.equal('page' in list, false, 'tabs list is NOT page-scoped');
  assert.ok(Array.isArray(list.data));
  assert.deepEqual(list.data.map((t) => t.page), ['PAGE1', 'PAGE2']);
  assert.deepEqual(list.data.map((t) => t.index), [0, 1]);
  // most-recently-minted is the active one
  assert.deepEqual(list.data.map((t) => t.active), [false, true]);
});

test('multi-lease: stable targetId persists across navigations within a lease', async () => {
  const target = fakeTarget('STABLE1', { title: 'A', url: 'https://a' });
  const provider = createMultiLeaseProvider({ createTarget: async () => target });
  const created = await dispatch(provider, { id: 'n', action: 'tabs', op: 'new' });
  const page = created.page;
  // two navigations on the same lease must echo the SAME page id
  const nav1 = await dispatch(provider, { id: 'v1', action: 'navigate', url: 'https://a/1', page });
  const nav2 = await dispatch(provider, { id: 'v2', action: 'navigate', url: 'https://a/2', page });
  assert.equal(nav1.page, page);
  assert.equal(nav2.page, page);
  assert.equal(page, 'STABLE1');
});

test('multi-lease: lease isolation — a command addresses exactly its own target', async () => {
  const t1 = fakeTarget('PAGE1', { exec: 'from-lease-1' });
  const t2 = fakeTarget('PAGE2', { exec: 'from-lease-2' });
  const targets = [t1, t2];
  let i = 0;
  const provider = createMultiLeaseProvider({ createTarget: async () => targets[i++] });
  await dispatch(provider, { id: 'a', action: 'tabs', op: 'new' });
  await dispatch(provider, { id: 'b', action: 'tabs', op: 'new' });

  const r1 = await dispatch(provider, { id: 'e1', action: 'exec', code: 'x', page: 'PAGE1' });
  const r2 = await dispatch(provider, { id: 'e2', action: 'exec', code: 'x', page: 'PAGE2' });
  assert.equal(r1.data, 'from-lease-1');
  assert.equal(r2.data, 'from-lease-2');
  assert.equal(r1.page, 'PAGE1');
  assert.equal(r2.page, 'PAGE2');
  // the right page answered: lease 1's exec only hit t1, never t2
  assert.ok(t1.sent.some((s) => s.method === 'Runtime.evaluate'));
  // t2 received its own exec but NOT lease-1's
  assert.equal(t2.sent.filter((s) => s.method === 'Runtime.evaluate').length, 1);
});

test('multi-lease: tabs select activates a lease; tabs close disposes it + its target', async () => {
  const t1 = fakeTarget('PAGE1');
  const t2 = fakeTarget('PAGE2');
  const targets = [t1, t2];
  let i = 0;
  const provider = createMultiLeaseProvider({ createTarget: async () => targets[i++] });
  await dispatch(provider, { id: 'a', action: 'tabs', op: 'new' });
  await dispatch(provider, { id: 'b', action: 'tabs', op: 'new' });

  // select PAGE1 → it becomes active, page-scoped result
  const sel = await dispatch(provider, { id: 's', action: 'tabs', op: 'select', page: 'PAGE1' });
  assert.equal(sel.ok, true);
  assert.deepEqual(sel.data, { selected: true });
  assert.equal(sel.page, 'PAGE1');

  // close PAGE2 → disposed; result carries closed:<targetId>, NOT page-scoped
  const close = await dispatch(provider, { id: 'c', action: 'tabs', op: 'close', page: 'PAGE2' });
  assert.equal(close.ok, true);
  assert.deepEqual(close.data, { closed: 'PAGE2' });
  assert.equal('page' in close, false);
  assert.equal(t2.isAlive(), false, 'closed lease target must be disposed');

  // list now shows only PAGE1; addressing PAGE2 is a stale-page error
  const list = await dispatch(provider, { id: 'l', action: 'tabs', op: 'list' });
  assert.deepEqual(list.data.map((t) => t.page), ['PAGE1']);
  // resolving a disposed lease throws StalePageError (the bridge's onMessage maps
  // it to {ok:false, errorCode:'stale_page'} via errorToResult — same as M1/M2).
  await assert.rejects(
    () => dispatch(provider, { id: 'x', action: 'exec', code: 'y', page: 'PAGE2' }),
    StalePageError,
  );
});

test('multi-lease: tabs new rejects non-http url scheme', async () => {
  const provider = createMultiLeaseProvider({ createTarget: async () => fakeTarget('PAGE1') });
  const r = await dispatch(provider, { id: 'n', action: 'tabs', op: 'new', url: 'file:///etc/passwd' });
  assert.equal(r.ok, false);
});

test('multi-lease: CDP allowlist is still enforced PER LEASE', async () => {
  const t1 = fakeTarget('PAGE1');
  const t2 = fakeTarget('PAGE2');
  const targets = [t1, t2];
  let i = 0;
  const provider = createMultiLeaseProvider({ createTarget: async () => targets[i++] });
  await dispatch(provider, { id: 'a', action: 'tabs', op: 'new' });
  await dispatch(provider, { id: 'b', action: 'tabs', op: 'new' });

  for (const page of ['PAGE1', 'PAGE2']) {
    const denied = await dispatch(provider, { id: 'x', action: 'cdp', page, cdpMethod: 'Page.navigate', cdpParams: { url: 'http://evil' } });
    assert.equal(denied.ok, false, `over-allowlist must be rejected on ${page}`);
    assert.equal(denied.errorCode, 'cdp_not_permitted');
  }
  // neither over-allowlist call ever reached a target
  assert.equal(t1.sent.length, 0);
  assert.equal(t2.sent.length, 0);
});

// ── M3: network capture (per-lease buffer) ───────────────────────────────────

test('network-capture: buffers requests/responses PER LEASE and drains on read', async () => {
  const t1 = fakeTarget('PAGE1');
  const t2 = fakeTarget('PAGE2');
  const targets = [t1, t2];
  let i = 0;
  const provider = createMultiLeaseProvider({ createTarget: async () => targets[i++] });
  await dispatch(provider, { id: 'a', action: 'tabs', op: 'new' });
  await dispatch(provider, { id: 'b', action: 'tabs', op: 'new' });
  const network = createNetworkCaptureRegistry();
  const caps = { network };

  // start capture on lease 1 only, with a substring pattern
  const start = await dispatch(provider, { id: 's', action: 'network-capture-start', page: 'PAGE1', pattern: '/api/' }, caps);
  assert.equal(start.ok, true);
  assert.deepEqual(start.data, { started: true });
  assert.equal(start.page, 'PAGE1');
  assert.ok(t1.sent.some((s) => s.method === 'Network.enable'));

  // fire real CDP events on lease 1: one matching, one non-matching
  t1.emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x/api/data', method: 'POST', headers: { 'x-h': '1' } } });
  t1.emit('Network.responseReceived', { requestId: 'r1', response: { status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' } } });
  t1.emit('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://x/static/app.js', method: 'GET' } });
  // an event on lease 2 must NOT leak into lease 1's buffer (isolation)
  t2.emit('Network.requestWillBeSent', { requestId: 'r9', request: { url: 'https://x/api/leak', method: 'GET' } });

  const read = await dispatch(provider, { id: 'r', action: 'network-capture-read', page: 'PAGE1' }, caps);
  assert.equal(read.ok, true);
  assert.equal(read.page, 'PAGE1');
  assert.ok(Array.isArray(read.data));
  // only the /api/ request matched the pattern; lease-2 traffic absent
  assert.equal(read.data.length, 1);
  assert.deepEqual(read.data[0], {
    kind: 'cdp',
    url: 'https://x/api/data',
    method: 'POST',
    requestHeaders: { 'x-h': '1' },
    timestamp: read.data[0].timestamp,
    responseStatus: 200,
    responseContentType: 'application/json',
    responseHeaders: { 'content-type': 'application/json' },
  });
  // read DRAINS the buffer (extension parity) — a second read is empty
  const read2 = await dispatch(provider, { id: 'r2', action: 'network-capture-read', page: 'PAGE1' }, caps);
  assert.deepEqual(read2.data, []);
});

// ── M3: wait-download (downloadResult shape) ─────────────────────────────────

test('wait-download: resolves on Page.downloadProgress completed with the extension result shape', async () => {
  const target = fakeTarget('PAGE1');
  const provider = createMultiLeaseProvider({ createTarget: async () => target });
  await dispatch(provider, { id: 'a', action: 'tabs', op: 'new' });
  const caps = { download: { downloadPath: '/tmp/render-dl', fileSize: () => 4242 } };

  const p = dispatch(provider, { id: 'd', action: 'wait-download', page: 'PAGE1', pattern: 'report', timeoutMs: 5000 }, caps);
  // simulate CDP download lifecycle for a matching file
  await new Promise((r) => setTimeout(r, 5));
  target.emit('Page.downloadWillBegin', { guid: 'g1', url: 'https://x/report.pdf', suggestedFilename: 'report.pdf' });
  target.emit('Page.downloadProgress', { guid: 'g1', state: 'inProgress', receivedBytes: 100 });
  target.emit('Page.downloadProgress', { guid: 'g1', state: 'completed', totalBytes: 4242 });

  const r = await p;
  assert.equal(r.ok, true);
  assert.equal('page' in r, false, 'wait-download is NOT page-scoped');
  assert.equal(r.data.downloaded, true);
  assert.equal(r.data.state, 'complete');
  assert.equal(r.data.filename, '/tmp/render-dl/report.pdf');
  assert.equal(r.data.url, 'https://x/report.pdf');
  assert.equal(r.data.totalBytes, 4242);
  assert.ok(typeof r.data.elapsedMs === 'number');
  // routing was configured over CDP
  assert.ok(target.sent.some((s) => s.method === 'Browser.setDownloadBehavior'));
});

test('wait-download: times out with the interrupted result shape', async () => {
  const target = fakeTarget('PAGE1');
  const provider = createMultiLeaseProvider({ createTarget: async () => target });
  await dispatch(provider, { id: 'a', action: 'tabs', op: 'new' });
  const caps = { download: { downloadPath: '/tmp/render-dl' } };
  const r = await dispatch(provider, { id: 'd', action: 'wait-download', page: 'PAGE1', pattern: 'nope', timeoutMs: 30 }, caps);
  assert.equal(r.ok, true);
  assert.equal(r.data.downloaded, false);
  assert.equal(r.data.state, 'interrupted');
  assert.ok(r.data.error.includes('timed out'));
});

// ── M2: cdp / cookies / screenshot / frames ──────────────────────────────────

test('cdp: allowlisted method forwards to target.send and returns the raw result, page-scoped', async () => {
  const doc = { root: { nodeId: 1, nodeName: '#document' } };
  const target = fakeTarget('PAGE1', { cdp: { 'DOM.getDocument': doc } });
  const provider = createSingleLeaseProvider({ createTarget: async () => target });
  await provider.acquire();

  const r = await dispatch(provider, {
    id: 'c1',
    action: 'cdp',
    page: 'PAGE1',
    cdpMethod: 'DOM.getDocument',
    cdpParams: { depth: -1 },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, doc);
  assert.equal(r.page, 'PAGE1');
  const call = target.sent.find((s) => s.method === 'DOM.getDocument');
  assert.deepEqual(call.params, { depth: -1 });
});

test('cdp: method OUTSIDE the allowlist is rejected and never reaches the target', async () => {
  const target = fakeTarget('PAGE1');
  const provider = createSingleLeaseProvider({ createTarget: async () => target });
  await provider.acquire();

  for (const method of ['Page.navigate', 'Network.enable', 'Browser.close', 'Target.createTarget']) {
    const r = await dispatch(provider, { id: 'x', action: 'cdp', page: 'PAGE1', cdpMethod: method });
    assert.equal(r.ok, false, `${method} must be rejected`);
    assert.equal(r.errorCode, 'cdp_not_permitted');
  }
  // none of the rejected methods were ever forwarded to the CDP target
  assert.equal(target.sent.length, 0);
  // every allowlisted method is exposed
  assert.ok(CDP_ALLOWLIST.has('Page.captureScreenshot'));
  assert.ok(CDP_ALLOWLIST.has('Page.getFrameTree'));
  assert.ok(!CDP_ALLOWLIST.has('Page.navigate'));
});

test('cdp: missing cdpMethod fails loudly', async () => {
  const provider = createSingleLeaseProvider({ createTarget: async () => fakeTarget('PAGE1') });
  const r = await dispatch(provider, { id: 'x', action: 'cdp', cdpMethod: '' });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'missing_cdp_method');
});

test('cdp: strips opencli frame-routing params before forwarding', async () => {
  const target = fakeTarget('PAGE1', { cdp: { 'DOM.getDocument': {} } });
  const provider = createSingleLeaseProvider({ createTarget: async () => target });
  await provider.acquire();
  await dispatch(provider, {
    id: 'c1',
    action: 'cdp',
    page: 'PAGE1',
    cdpMethod: 'DOM.getDocument',
    cdpParams: { depth: -1, frameId: 'f2', sessionId: 'target', targetUrl: 'https://child' },
  });
  const call = target.sent.find((s) => s.method === 'DOM.getDocument');
  assert.deepEqual(call.params, { depth: -1 }, 'frame routing keys must be stripped');
});

test('cookies: maps Network.getCookies → extension wire shape; ARRAY, NO page field', async () => {
  const cookies = [
    { name: 'sid', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: 1893456000 },
    { name: 'tmp', value: 'z', domain: 'example.com', path: '/', secure: false, httpOnly: false, expires: -1 },
    { name: 'other', value: 'q', domain: 'other.com', path: '/', secure: false, httpOnly: false, expires: -1 },
  ];
  const target = fakeTarget('PAGE1', { cookies });
  const provider = createSingleLeaseProvider({ createTarget: async () => target });
  await provider.acquire();

  const r = await dispatch(provider, { id: 'k1', action: 'cookies', page: 'PAGE1', domain: 'example.com' });
  assert.equal(r.ok, true);
  assert.equal('page' in r, false, 'cookies Result must NOT carry a page field');
  assert.ok(Array.isArray(r.data));
  // domain-scoped: other.com filtered out
  assert.deepEqual(r.data.map((c) => c.name), ['sid', 'tmp']);
  // session cookie (expires <= 0) drops expirationDate; persistent maps expires→expirationDate
  assert.deepEqual(r.data[0], {
    name: 'sid', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true, expirationDate: 1893456000,
  });
  assert.equal('expirationDate' in r.data[1], false);
});

test('cookies: scope guard — no domain AND no url is rejected (never dump all cookies)', async () => {
  const target = fakeTarget('PAGE1', { cookies: [{ name: 'a', value: '1', domain: 'x', path: '/', secure: false, httpOnly: false }] });
  const provider = createSingleLeaseProvider({ createTarget: async () => target });
  await provider.acquire();
  const r = await dispatch(provider, { id: 'k1', action: 'cookies', page: 'PAGE1' });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'cookie_scope_required');
  assert.equal(target.sent.length, 0, 'must not even query cookies without a scope');
});

test('cookies: url scope passes urls:[url] to Network.getCookies', async () => {
  const target = fakeTarget('PAGE1', { cookies: [] });
  const provider = createSingleLeaseProvider({ createTarget: async () => target });
  await provider.acquire();
  await dispatch(provider, { id: 'k1', action: 'cookies', page: 'PAGE1', url: 'https://example.com/p' });
  const call = target.sent.find((s) => s.method === 'Network.getCookies');
  assert.deepEqual(call.params, { urls: ['https://example.com/p'] });
});

test('screenshot: Page.captureScreenshot → base64 STRING in data, page-scoped; jpeg clamps quality', async () => {
  const target = fakeTarget('PAGE1', { screenshot: 'aGVsbG8=' });
  const provider = createSingleLeaseProvider({ createTarget: async () => target });
  await provider.acquire();

  const png = await dispatch(provider, { id: 's1', action: 'screenshot', page: 'PAGE1' });
  assert.equal(png.ok, true);
  assert.equal(typeof png.data, 'string', 'data must be the raw base64 string (client does const b64 = data)');
  assert.equal(png.data, 'aGVsbG8=');
  assert.equal(png.page, 'PAGE1');
  assert.deepEqual(target.sent.find((s) => s.method === 'Page.captureScreenshot').params, { format: 'png' });

  const jpeg = await dispatch(provider, { id: 's2', action: 'screenshot', page: 'PAGE1', format: 'jpeg', quality: 250 });
  assert.equal(jpeg.ok, true);
  const shot = target.sent.filter((s) => s.method === 'Page.captureScreenshot').at(-1);
  assert.deepEqual(shot.params, { format: 'jpeg', quality: 100 }, 'quality clamped to 0..100');
});

test('frames: Page.getFrameTree → cross-origin enumeration ARRAY (same-origin recursed through), page-scoped', async () => {
  // root https://a.com → child https://a.com/inner (same origin, NOT emitted, recursed)
  //                          └ grandchild https://b.com (cross-origin, emitted)
  //                    → child https://c.com (cross-origin, emitted)
  const frameTree = {
    frameTree: {
      frame: { id: 'root', url: 'https://a.com/' },
      childFrames: [
        {
          frame: { id: 'f-same', url: 'https://a.com/inner' },
          childFrames: [{ frame: { id: 'f-b', url: 'https://b.com/', name: 'bframe' } }],
        },
        { frame: { id: 'f-c', url: 'https://c.com/' } },
      ],
    },
  };
  const target = fakeTarget('PAGE1', { frameTree });
  const provider = createSingleLeaseProvider({ createTarget: async () => target });
  await provider.acquire();

  const r = await dispatch(provider, { id: 'fr1', action: 'frames', page: 'PAGE1' });
  assert.equal(r.ok, true);
  assert.equal(r.page, 'PAGE1');
  assert.ok(Array.isArray(r.data));
  assert.deepEqual(r.data, [
    { index: 0, frameId: 'f-b', url: 'https://b.com/', name: 'bframe' },
    { index: 1, frameId: 'f-c', url: 'https://c.com/', name: '' },
  ]);
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
