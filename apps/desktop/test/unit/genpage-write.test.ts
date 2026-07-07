/**
 * genpage-write — unit + kernel-integration coverage for the generated-page
 * WRITE path (spec-guard, render-page sentinel, page-action forwarding, and
 * the ux-server ↔ opencli-ux keep/JSONL/confirm-broker seam).
 *
 *   pnpm --filter @render/desktop test:unit     (tsx --test)
 *
 * The kernel-integration test spawns the REAL opencli-ux ux.mjs (sibling
 * checkout or RENDER_PORTAL_UX_MJS) with a stubbed opencli (OPENCLI_BIN); it
 * self-skips when ux.mjs is not present so the suite runs anywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validatePageSpec } from '../../src/main/spec-guard.js';
import { parseRenderPage, RENDER_PAGE_SENTINEL } from '../../src/main/agent-instructions.js';
import { pageActionToPrompt } from '../../src/main/agent-runtime.js';
import { serveUxSpec, resolveUxMjs } from '../../src/main/ux-server.js';
import { createUxConfirmBroker, type UxWriteRequest } from '../../src/main/ux-confirm-broker.js';

// ── spec-guard ────────────────────────────────────────────────────────────────

const el = (type: string, on?: unknown) => ({ type, props: {}, ...(on ? { on } : {}) });

test('spec-guard: page actions (incl. ux_submit/ux_confirm) pass; foreign actions fail', () => {
  const spec = JSON.stringify({
    root: 'root',
    elements: {
      root: { type: 'Stack', props: {}, children: ['submit', 'choose', 'close'] },
      submit: el('Button', { press: { action: 'ux_submit' } }),
      choose: el('Button', { press: { action: 'ux_confirm', params: { choice: 'ok' } } }),
      close: el('Button', { press: { action: 'ux_cancel' } }),
    },
  });
  assert.equal(validatePageSpec(spec, '').ok, true);

  const bad = JSON.stringify({
    root: 'root',
    elements: { root: el('Button', { press: { action: 'ux_instruct' } }) },
  });
  const r = validatePageSpec(bad, '');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /ux_instruct.*not a page action/);
});

test('spec-guard: ux_data must be covered by --allow ∪ --allow-write', () => {
  const spec = JSON.stringify({
    root: 'root',
    elements: {
      root: { type: 'Stack', props: {}, children: ['read', 'write'] },
      read: el('FeedList', { mount: { action: 'ux_data', params: { key: 'r', request: { site: 'arxiv', command: 'recent' } } } }),
      write: el('Button', { press: { action: 'ux_data', params: { key: 'w', request: { site: 'dianping', command: 'reply' } } } }),
    },
  });
  assert.equal(validatePageSpec(spec, 'arxiv recent', 'dianping reply').ok, true);

  const missing = validatePageSpec(spec, 'arxiv recent');
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /dianping reply/.test(e)));
});

test('spec-guard: malformed input fails closed', () => {
  assert.equal(validatePageSpec('not json', '').ok, false);
  assert.equal(validatePageSpec('[1,2]', '').ok, false);
  // a full spec is required — a simple {title} shape has no root/elements
  assert.equal(validatePageSpec(JSON.stringify({ title: 'simple' }), '').ok, false);
  // a malformed --allow-write grant is itself a hard error
  const okSpec = JSON.stringify({ root: 'r', elements: { r: { type: 'Text', props: {} } } });
  const badGrant = validatePageSpec(okSpec, '', 'justasite');
  assert.equal(badGrant.ok, false);
  assert.match(badGrant.errors.join(' '), /--allow-write.*not a "<site> <command>" pair/);
  // a well-formed full spec with a clean read grant passes
  assert.equal(validatePageSpec(okSpec, 'arxiv recent').ok, true);
});

// ── render-page sentinel ─────────────────────────────────────────────────────

test('parseRenderPage: reads the --allow-write field (and tolerates its absence)', () => {
  const withWrite = `${RENDER_PAGE_SENTINEL}\t/w/app.json\t门户\tagg search\tdianping reply`;
  assert.deepEqual(parseRenderPage(withWrite), {
    file: '/w/app.json',
    title: '门户',
    allow: 'agg search',
    allowWrite: 'dianping reply',
  });
  const legacy = `${RENDER_PAGE_SENTINEL}\t/w/app.json\t门户\tagg search`;
  assert.deepEqual(parseRenderPage(legacy), { file: '/w/app.json', title: '门户', allow: 'agg search' });
});

// ── page-action prompt ───────────────────────────────────────────────────────

test('pageActionToPrompt: submit/confirm round-trip, cancel is dropped', () => {
  const submit = pageActionToPrompt('门户', { submitted: true, action: 'ux_submit', values: { q: '42' } });
  assert.ok(submit && submit.includes('[page action]') && submit.includes('"门户"') && submit.includes('"q":"42"'));
  const confirm = pageActionToPrompt(undefined, { action: 'ux_confirm', choice: '允许' });
  assert.ok(confirm && confirm.includes('a generated page') && confirm.includes('"允许"'));
  assert.equal(pageActionToPrompt('门户', { action: 'ux_cancel' }), null);
  assert.equal(pageActionToPrompt('门户', 'garbage'), null);
});

// ── ux-server ↔ real kernel: keep JSONL callbacks + brokered writes ──────────

test('serveUxSpec: keep-mode callbacks forward and writes go through the broker', async (t) => {
  const uxMjs = resolveUxMjs();
  if (!uxMjs) {
    t.skip('opencli-ux ux.mjs not found (set RENDER_PORTAL_UX_MJS) — kernel integration skipped');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'render-genpage-'));
  const stubBin = join(dir, 'opencli-stub');
  writeFileSync(stubBin, '#!/bin/sh\necho \'[{"stub":true}]\'\n');
  chmodSync(stubBin, 0o755);
  process.env.OPENCLI_BIN = stubBin;
  t.after(() => {
    delete process.env.OPENCLI_BIN;
  });

  const confirmed: UxWriteRequest[] = [];
  const broker = createUxConfirmBroker({
    requestConfirm: async (req) => {
      confirmed.push(req);
      return req.command !== 'delete'; // approve everything except "delete"
    },
  });
  t.after(() => broker.dispose());
  const confirm = await broker.endpoint();
  assert.ok(confirm, 'broker must bind');

  const callbacks: unknown[] = [];
  const page = serveUxSpec({
    specJson: JSON.stringify({
      root: 'root',
      elements: { root: { type: 'Button', props: { label: 'go' }, on: { press: { action: 'ux_submit' } } } },
    }),
    allow: 'demo read',
    allowWrite: 'demo post,demo delete',
    confirm,
    onCallback: (payload) => callbacks.push(payload),
    idTag: `test-${process.pid}`,
  });
  t.after(() => page.dispose());

  const url = await page.whenReady();
  assert.ok(url, 'kernel must announce a url');
  assert.ok(page.session, 'kernel must announce its session');

  const cfg = (await (await fetch(new URL('/ux/config', url!))).json()) as {
    keep: boolean;
    token: string;
    session: string;
    allowWrite: string[];
  };
  assert.equal(cfg.keep, true);
  assert.deepEqual(cfg.allowWrite, ['demo post', 'demo delete']);

  const post = (path: string, body: unknown) =>
    fetch(new URL(path, url!), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ux-token': cfg.token },
      body: JSON.stringify(body),
    });

  // page action → JSONL → onCallback
  const payload = { submitted: true, action: 'ux_submit', values: { note: 'hi' } };
  assert.equal((await post(`/ux/callback/${cfg.session}`, payload)).status, 204);
  await waitUntil(() => callbacks.length === 1, 'callback forwarded');
  assert.deepEqual(callbacks[0], payload);

  // write-granted command runs after the broker approves
  const approved = (await (await post('/ux/data', { site: 'demo', command: 'post', args: { m: '1' } })).json()) as {
    ok: boolean;
  };
  assert.equal(approved.ok, true);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].command, 'post');
  assert.equal(confirmed[0].session, cfg.session);

  // broker denial fails the write closed
  const denied = (await (await post('/ux/data', { site: 'demo', command: 'delete' })).json()) as {
    ok: boolean;
    code?: string;
  };
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'write_denied');
});

function waitUntil(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}
