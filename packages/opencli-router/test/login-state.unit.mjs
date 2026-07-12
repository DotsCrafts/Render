/**
 * Unit tests for the connector login-state surface of the app-hand router
 * (no opencli binary, no daemon, no network).
 *
 * Pins the opencli 1.8.4 whoami contract the Connectors product depends on:
 *   • exit 77 / logged_in:false are the ONLY "disconnected" signals;
 *   • a whoami failing PAST the auth gate (verify scraper drift) means the
 *     session is LIVE — never paint it signed-out;
 *   • infra failures (bridge down, timeout, missing binary, CLI rejections)
 *     are 'unknown', so a dead daemon can't flip every connector to signed-out;
 *   • whoami/login/logout all carry `--site-session persistent` — without it
 *     they run ephemeral and falsely report AUTH_REQUIRED;
 *   • sites() aggregates the catalog per site with auth-command counts.
 *
 * Run: node test/run.mjs   (pnpm --filter @render/opencli-router test)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhoami, AUTH_REQUIRED_EXIT, BROWSER_CONNECT_EXIT } from '../src/parse.ts';
import { MetadataIndex } from '../src/metadata.ts';
import { createOpencliRouter } from '../src/router.ts';

const exec = (exitCode, stdout = '', stderr = '') => ({ exitCode, stdout, stderr });

// ── parseWhoami: the login-state truth table ─────────────────────────────────

test('parseWhoami: exit 0 + logged_in:true is connected, with the account label', () => {
  const p = parseWhoami(exec(0, '[{"logged_in":true,"user_name":"drej"}]'));
  assert.deepEqual(p, { kind: 'connected', account: 'drej' });
});

test('parseWhoami: account falls back through nickname/name when user_name absent', () => {
  const p = parseWhoami(exec(0, '{"logged_in":true,"nickname":"小明"}'));
  assert.deepEqual(p, { kind: 'connected', account: '小明' });
});

test('parseWhoami: exit 0 + logged_in:false is disconnected', () => {
  assert.deepEqual(parseWhoami(exec(0, '{"logged_in":false}')), { kind: 'disconnected' });
  assert.deepEqual(parseWhoami(exec(0, '{"status":"logged_out"}')), { kind: 'disconnected' });
});

test('parseWhoami: exit 77 is authoritative disconnected, even with empty output', () => {
  assert.deepEqual(parseWhoami(exec(AUTH_REQUIRED_EXIT)), { kind: 'disconnected' });
});

test('parseWhoami: verify-scraper drift (COMMAND_EXEC past the auth gate) is CONNECTED', () => {
  const p = parseWhoami(
    exec(1, '', 'COMMAND_EXEC: member page rendered but no user_id link found'),
  );
  assert.equal(p.kind, 'connected');
  assert.match(p.detail, /verify drifted/);
});

test('parseWhoami: an ENGINE failure is unknown — never connected (smoke-caught lie)', () => {
  // the exact OpenCLIApp drift the desktop smoke hit: every whoami failed with
  // exit 78 and this stderr, and the old drift rule painted ALL sites Connected.
  const engine = parseWhoami(
    exec(
      78,
      '',
      'error: OPENCLI_DAEMON_PORT is no longer supported (received 19825). Unset OPENCLI_DAEMON_PORT and rerun opencli.',
    ),
  );
  assert.equal(engine.kind, 'unknown');
  assert.match(engine.detail, /whoami failed/);

  const network = parseWhoami(exec(1, '', 'fetch failed: network unreachable'));
  assert.equal(network.kind, 'unknown');
});

test('parseWhoami: browser bridge down is unknown, never disconnected', () => {
  const p = parseWhoami(exec(BROWSER_CONNECT_EXIT, '', 'browser profile not connected'));
  assert.equal(p.kind, 'unknown');
  assert.match(p.detail, /bridge/);
});

test('parseWhoami: timeout (124) and missing binary (127) are unknown', () => {
  assert.equal(parseWhoami(exec(124, '', 'timed out')).kind, 'unknown');
  assert.equal(parseWhoami(exec(127, '', 'opencli: command not found')).kind, 'unknown');
});

test('parseWhoami: CLI-layer rejections (unknown command/flag) are unknown', () => {
  assert.equal(parseWhoami(exec(2, '', "error: unknown command 'whoami'")).kind, 'unknown');
  assert.equal(parseWhoami(exec(2, '', 'unknown option --site-session')).kind, 'unknown');
});

test('parseWhoami: non-77 exit with an explicit auth message is disconnected', () => {
  assert.deepEqual(parseWhoami(exec(1, '', 'AUTH_REQUIRED: Not logged in')), {
    kind: 'disconnected',
  });
});

test('parseWhoami: exit 0 with no JSON is unknown (no fabricated verdicts)', () => {
  assert.equal(parseWhoami(exec(0, 'plain text banner')).kind, 'unknown');
});

// ── MetadataIndex.sites(): per-site aggregation ──────────────────────────────

const META_ROWS = [
  { command: 'zhihu/hot', site: 'zhihu', name: 'hot', strategy: 'cookie', browser: false, access: 'read', args: [], domain: 'zhihu.com' },
  { command: 'zhihu/whoami', site: 'zhihu', name: 'whoami', strategy: 'cookie', browser: false, access: 'read', args: [], domain: 'zhihu.com' },
  { command: 'zhihu/search', site: 'zhihu', name: 'search', strategy: 'public', browser: false, access: 'read', args: [] },
  { command: 'arxiv/search', site: 'arxiv', name: 'search', strategy: 'public', browser: false, access: 'read', args: [], domain: 'arxiv.org' },
  { command: 'ux/render', site: 'ux', name: 'render', strategy: 'local', browser: false, access: 'read', args: [] },
];

test('sites(): aggregates command + auth counts per site, alphabetical, with domains', async () => {
  const index = new MetadataIndex();
  await index.load(async () => exec(0, JSON.stringify(META_ROWS)));
  assert.deepEqual(index.sites(), [
    { site: 'arxiv', domain: 'arxiv.org', commands: 1, authCommands: 0 },
    { site: 'ux', commands: 1, authCommands: 0 },
    { site: 'zhihu', domain: 'zhihu.com', commands: 3, authCommands: 2 },
  ]);
});

// ── router: whoami / logout / login argv + gating ────────────────────────────

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

test('whoami: runs `<site> whoami --site-session persistent -f json`, bounded, over CDP', async () => {
  const sb = fakeSandbox((args) => {
    if (args[0] === 'list') return listOk();
    return exec(0, '[{"logged_in":true,"user_name":"drej"}]');
  });
  const router = createOpencliRouter({
    sandbox: sb.provider,
    humanHand: { cdpEndpoint: async () => 'ws://127.0.0.1:9333' },
  });

  const probe = await router.whoami('zhihu');
  assert.deepEqual(probe, { kind: 'connected', account: 'drej' });

  const call = sb.calls.find((c) => c.args[1] === 'whoami');
  assert.deepEqual(call.args, ['zhihu', 'whoami', '--site-session', 'persistent', '-f', 'json']);
  assert.equal(typeof call.opts.timeoutMs, 'number', 'whoami must be deadline-bounded');
  assert.equal(call.opts.env.OPENCLI_CDP_ENDPOINT, 'http://127.0.0.1:9333');
});

test('whoami: a site with no whoami command is unknown WITHOUT spawning a probe', async () => {
  const sb = fakeSandbox((args) => (args[0] === 'list' ? listOk() : exec(0, '[]')));
  const router = createOpencliRouter({ sandbox: sb.provider });

  const probe = await router.whoami('arxiv');
  assert.equal(probe.kind, 'unknown');
  assert.equal(
    sb.calls.some((c) => c.args[1] === 'whoami'),
    false,
    'no probe process may spawn for an adapter without whoami',
  );
});

test('login: carries --site-session persistent (cookie must land in the persistent session)', async () => {
  const sb = fakeSandbox((args) => {
    if (args[0] === 'list') return listOk();
    return exec(0, '[{"logged_in":true,"user_name":"drej"}]');
  });
  const router = createOpencliRouter({
    sandbox: sb.provider,
    humanHand: { cdpEndpoint: async () => 'ws://127.0.0.1:9333' },
  });

  const res = await router.login('zhihu');
  assert.deepEqual(res, { loggedIn: true, account: 'drej' });
  const call = sb.calls.find((c) => c.args[1] === 'login');
  assert.deepEqual(call.args, ['zhihu', 'login', '--site-session', 'persistent', '-f', 'json']);
  assert.equal(call.opts.timeoutMs, undefined, 'login must stay unbounded');
});

test('logout: gated on the adapter having a logout command', async () => {
  const rows = [
    ...META_ROWS,
    { command: 'zhihu/logout', site: 'zhihu', name: 'logout', strategy: 'cookie', browser: false, access: 'write', args: [], domain: 'zhihu.com' },
  ];
  const sb = fakeSandbox((args) =>
    args[0] === 'list' ? exec(0, JSON.stringify(rows)) : exec(0, '[{"logged_in":false}]'),
  );
  const router = createOpencliRouter({ sandbox: sb.provider });

  assert.deepEqual(await router.logout('zhihu'), { supported: true });
  const call = sb.calls.find((c) => c.args[1] === 'logout');
  assert.deepEqual(call.args, ['zhihu', 'logout', '--site-session', 'persistent', '-f', 'json']);

  assert.deepEqual(await router.logout('arxiv'), { supported: false });
  assert.equal(
    sb.calls.filter((c) => c.args[1] === 'logout').length,
    1,
    'no logout process may spawn for an adapter without the command',
  );
});

test('listSites: surfaces the aggregated catalog through the router', async () => {
  const sb = fakeSandbox((args) => (args[0] === 'list' ? listOk() : exec(0, '[]')));
  const router = createOpencliRouter({ sandbox: sb.provider });
  const sites = await router.listSites();
  assert.deepEqual(
    sites.map((s) => s.site),
    ['arxiv', 'ux', 'zhihu'],
  );
  assert.deepEqual(sites[2], { site: 'zhihu', domain: 'zhihu.com', commands: 3, authCommands: 2 });
});
