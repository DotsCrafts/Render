/**
 * Unit tests for the app-hand router (no opencli binary, no daemon, no network).
 *
 * Pins the regressions the M-audit confirmed:
 *   • auth/browser detection must be EXIT-CODE gated — a successful scrape
 *     containing "Please log in" prose must NOT become a blocking login card;
 *   • extractLoginUrl must not grab arbitrary scraped data URLs;
 *   • a failed `opencli list` (daemon cold boot) must not poison the
 *     classification cache for the rest of the session;
 *   • the public route maps AUTH_REQUIRED/BROWSER_CONNECT to needsLogin;
 *   • exec deadlines are route-aware, and `login` stays unbounded;
 *   • deps.browserEndpoint wins over humanHand, with fallback on failure.
 *
 * Run: node test/run.mjs   (pnpm --filter @render/opencli-router test)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuthRequired,
  isBrowserUnavailable,
  extractLoginUrl,
  AUTH_REQUIRED_EXIT,
  BROWSER_CONNECT_EXIT,
} from '../src/parse.ts';
import { createOpencliRouter } from '../src/router.ts';

const exec = (exitCode, stdout = '', stderr = '') => ({ exitCode, stdout, stderr });

// ── isAuthRequired: exit-code gating ─────────────────────────────────────────

test('isAuthRequired: exit-0 output containing login words is NOT auth-required', () => {
  assert.equal(
    isAuthRequired(exec(0, '[{"text":"Please log in to reply","replies":42}]')),
    false,
  );
  assert.equal(isAuthRequired(exec(0, 'Sign in at the top right to comment')), false);
  assert.equal(isAuthRequired(exec(0, 'Not logged in users see a paywall')), false);
});

test('isAuthRequired: exit 77 is authoritative even with empty output', () => {
  assert.equal(isAuthRequired(exec(AUTH_REQUIRED_EXIT)), true);
});

test('isAuthRequired: non-zero exit + auth message triggers; benign failure does not', () => {
  assert.equal(isAuthRequired(exec(1, '', 'AUTH_REQUIRED: Not logged in')), true);
  assert.equal(isAuthRequired(exec(1, '', 'network unreachable')), false);
});

// ── isBrowserUnavailable: same gate ──────────────────────────────────────────

test('isBrowserUnavailable: text branch requires a non-zero exit', () => {
  assert.equal(isBrowserUnavailable(exec(0, 'article about code: BROWSER_CONNECT errors')), false);
  assert.equal(isBrowserUnavailable(exec(1, '', 'failed, code: BROWSER_CONNECT')), true);
  assert.equal(
    isBrowserUnavailable(exec(BROWSER_CONNECT_EXIT, '', 'browser profile not connected')),
    true,
  );
  assert.equal(isBrowserUnavailable(exec(BROWSER_CONNECT_EXIT, '', 'unrelated failure')), false);
});

// ── extractLoginUrl: no arbitrary scraped URLs ───────────────────────────────

test('extractLoginUrl: prefers the URL on the auth-message line over earlier data URLs', () => {
  const e = exec(
    AUTH_REQUIRED_EXIT,
    'found https://example.com/article/1\nAUTH_REQUIRED: Sign in at https://passport.zhihu.com/login',
  );
  assert.equal(extractLoginUrl(e, 'zhihu.com'), 'https://passport.zhihu.com/login');
});

test('extractLoginUrl: accepts a URL whose host matches the adapter domain', () => {
  const e = exec(1, 'visit https://www.zhihu.com/signin to continue');
  assert.equal(extractLoginUrl(e, 'zhihu.com'), 'https://www.zhihu.com/signin');
});

test('extractLoginUrl: a lone scraped data URL is ignored → synthesized domain fallback', () => {
  const e = exec(1, 'top result: https://random-blog.example/post/9');
  assert.equal(extractLoginUrl(e, 'zhihu.com'), 'https://zhihu.com');
  assert.equal(extractLoginUrl(e), undefined);
});

// ── router-level behaviour, over a fake sandbox ──────────────────────────────

const META_ROWS = [
  {
    command: 'foo/bar',
    site: 'foo',
    name: 'bar',
    strategy: 'public',
    browser: false,
    access: 'read',
    args: [],
    domain: 'foo.example',
  },
  {
    command: 'zhihu/hot',
    site: 'zhihu',
    name: 'hot',
    strategy: 'cookie',
    browser: false,
    access: 'read',
    args: [],
    domain: 'zhihu.com',
  },
];

/** A recording SandboxProvider whose exec is scripted per-argv. */
function fakeSandbox(execImpl) {
  const calls = [];
  return {
    calls,
    provider: {
      id: 'fake',
      async start() {},
      workdir: () => '/tmp/fake-sbx',
      async exec(cmd, args, opts = {}) {
        calls.push({ cmd, args, opts });
        return execImpl(args, opts);
      },
      spawn() {
        throw new Error('spawn unused in router tests');
      },
      async dispose() {},
    },
  };
}

const listOk = () => exec(0, JSON.stringify(META_ROWS));

test('classify: a failed metadata load is NOT cached — next call re-derives from metadata', async () => {
  let daemonUp = false;
  const sb = fakeSandbox((args) => {
    if (args[0] === 'list') return daemonUp ? listOk() : exec(1, '', 'daemon not reachable');
    return exec(0, '[]');
  });
  const router = createOpencliRouter({ sandbox: sb.provider });

  // cold boot: metadata fails → allowlist fallback (zhihu is cookie there, an
  // unknown site defaults public) — and neither result may stick.
  assert.equal(await router.classify('foo', 'bar'), 'public');
  assert.equal(await router.classify('zhihu', 'hot'), 'cookie');

  daemonUp = true;
  // same keys re-classified from real metadata — a poisoned cache would keep
  // returning the fallback for the app's lifetime.
  assert.equal(await router.classify('foo', 'bar'), 'public');
  assert.equal(router.catalogSize(), 2);
  // now cached from metadata: flipping the daemon off must not matter.
  daemonUp = false;
  assert.equal(await router.classify('zhihu', 'hot'), 'cookie');
});

test('invoke (public route): AUTH_REQUIRED maps to needsLogin with a real login URL', async () => {
  const sb = fakeSandbox((args) => {
    if (args[0] === 'list') return listOk();
    return exec(
      AUTH_REQUIRED_EXIT,
      '',
      'AUTH_REQUIRED: Sign in at https://login.foo.example/signin',
    );
  });
  const router = createOpencliRouter({ sandbox: sb.provider });
  const res = await router.invoke({ site: 'foo', command: 'bar' });

  assert.equal(res.ok, false);
  assert.equal(res.ranOn, 'sandbox');
  assert.equal(res.error, 'login required');
  assert.deepEqual(res.needsLogin, {
    site: 'foo',
    loginUrl: 'https://login.foo.example/signin',
  });
});

test('invoke (public route): exit-0 result with login-ish prose stays a SUCCESS', async () => {
  const rows = '[{"title":"Please log in to reply — thread","url":"https://x/1"}]';
  const sb = fakeSandbox((args) => (args[0] === 'list' ? listOk() : exec(0, rows)));
  const router = createOpencliRouter({ sandbox: sb.provider });
  const res = await router.invoke({ site: 'foo', command: 'bar' });

  assert.equal(res.ok, true, 'a successful scrape must never become a login wall');
  assert.equal(res.needsLogin, undefined);
  assert.deepEqual(res.data, [{ title: 'Please log in to reply — thread', url: 'https://x/1' }]);
});

test('deadlines: metadata 30s, public 60s, browser 120s, login unbounded', async () => {
  const sb = fakeSandbox((args) => {
    if (args[0] === 'list') return listOk();
    if (args[1] === 'login') return exec(0, '[{"logged_in":true,"user_name":"drej"}]');
    return exec(0, '[]');
  });
  const router = createOpencliRouter({
    sandbox: sb.provider,
    humanHand: { cdpEndpoint: async () => 'ws://127.0.0.1:9333' },
  });

  await router.invoke({ site: 'foo', command: 'bar' }); // public
  await router.invoke({ site: 'zhihu', command: 'hot' }); // cookie → browser route
  await router.login('zhihu'); // human-paced

  const byArgs = (pred) => sb.calls.find((c) => pred(c.args));
  assert.equal(byArgs((a) => a[0] === 'list').opts.timeoutMs, 30_000);
  assert.equal(byArgs((a) => a[0] === 'foo').opts.timeoutMs, 60_000);
  assert.equal(byArgs((a) => a[0] === 'zhihu' && a[1] === 'hot').opts.timeoutMs, 120_000);
  const login = byArgs((a) => a[1] === 'login');
  assert.equal(login.opts.timeoutMs, undefined, 'login must stay unbounded');
  assert.equal(login.opts.env.OPENCLI_CDP_ENDPOINT, 'http://127.0.0.1:9333');
});

test('browserEndpoint: injected endpoint wins; falls back to humanHand when it throws', async () => {
  const sb = fakeSandbox(() => exec(0, '[]'));
  const preferred = createOpencliRouter({
    sandbox: sb.provider,
    humanHand: { cdpEndpoint: async () => 'ws://127.0.0.1:1111' },
    browserEndpoint: async () => 'ws://127.0.0.1:9333',
  });
  assert.equal(await preferred.browserEndpoint(), 'http://127.0.0.1:9333');

  const failing = createOpencliRouter({
    sandbox: sb.provider,
    humanHand: { cdpEndpoint: async () => 'ws://127.0.0.1:1111' },
    browserEndpoint: async () => {
      throw new Error('render CDP disabled');
    },
  });
  assert.equal(await failing.browserEndpoint(), 'http://127.0.0.1:1111');

  const none = createOpencliRouter({ sandbox: sb.provider });
  assert.equal(await none.browserEndpoint(), null);
});
