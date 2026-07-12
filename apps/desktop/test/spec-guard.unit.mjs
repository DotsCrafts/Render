// spec-guard — deliver-time validation of agent-authored page specs.
// Pins the review finding: non-page actions hidden in ARRAY-form `on` bindings
// or `watch` bindings must not sail past the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePageSpec } from '../src/main/spec-guard.ts';

const el = (type, extra = {}) => ({ type, props: {}, ...extra });
const spec = (elements) => JSON.stringify({ root: 'root', state: {}, elements });

test('valid spec with allowlisted ux_data mount passes', () => {
  const r = validatePageSpec(
    spec({
      root: el('Stack', { children: ['feed'] }),
      feed: el('FeedList', {
        on: {
          mount: {
            action: 'ux_data',
            params: { key: 'k', request: { site: 'arxiv', command: 'search' } },
          },
        },
      }),
    }),
    'arxiv search',
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('non-page action ux_instruct in a plain binding is rejected', () => {
  const r = validatePageSpec(
    spec({ root: el('Button', { on: { press: { action: 'ux_instruct' } } }) }),
    '',
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /ux_instruct/);
});

test('non-page action hidden in an ARRAY binding is rejected', () => {
  const r = validatePageSpec(
    spec({
      root: el('Button', {
        on: {
          press: [
            { action: 'ux_data', params: { key: 'k', request: { site: 'arxiv', command: 'search' } } },
            { action: 'ux_instruct' },
          ],
        },
      }),
    }),
    'arxiv search',
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /ux_instruct/);
});

test('non-page action in a WATCH binding is rejected', () => {
  const r = validatePageSpec(
    spec({ root: el('Stack', { watch: { '/q': { action: 'ux_instruct' } } }) }),
    '',
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /ux_instruct/);
});

test('non-page action nested in an onSuccess chain is rejected', () => {
  const r = validatePageSpec(
    spec({
      root: el('Button', {
        on: {
          press: {
            action: 'ux_data',
            params: { key: 'k', request: { site: 'arxiv', command: 'search' } },
            onSuccess: { action: 'ux_instruct' },
          },
        },
      }),
    }),
    'arxiv search',
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /ux_instruct/);
});

test('ux_data request outside the --allow list is rejected, agent-actionably', () => {
  const r = validatePageSpec(
    spec({
      root: el('FeedList', {
        on: {
          mount: { action: 'ux_data', params: { key: 'k', request: { site: 'zhihu', command: 'hot' } } },
        },
      }),
    }),
    'arxiv search',
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /zhihu hot.*--allow/);
});

test('structural breakage (missing root, dangling child) is rejected', () => {
  const r = validatePageSpec(
    JSON.stringify({ root: 'nope', elements: { a: el('Stack', { children: ['ghost'] }) } }),
    '',
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /root "nope"/);
  assert.match(r.errors.join('\n'), /missing child "ghost"/);
});

test('unknown component type warns but does not reject (catalog drift tolerance)', () => {
  const r = validatePageSpec(spec({ root: el('HoloDeck') }), '');
  assert.equal(r.ok, true);
  assert.match(r.warnings.join('\n'), /HoloDeck/);
});

test('the seeded canonical example passes the guard with its own allow pairs', async (t) => {
  const { readFile } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  let content;
  try {
    content = await readFile(
      join(homedir(), 'workspace', 'opencli-ux', 'examples', 'portal-jsonrender-live.json'),
      'utf8',
    );
  } catch {
    t.skip('opencli-ux checkout not present');
    return;
  }
  const r = validatePageSpec(
    content,
    'agg search,coingecko top,arxiv recent,36kr news,wttr current',
  );
  assert.equal(r.ok, true, r.errors.join('\n'));
});
