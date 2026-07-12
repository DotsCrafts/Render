// ConnectorService — the Manus-connector state machine over fake router/store.
// Pins the product guarantees:
//   • the page paints from cached state and NEVER probes on list();
//   • refresh probes only STALE login sites (bounded), never public ones;
//   • connect opens the site's login tab and the whoami watch flips the row to
//     connected BY ITSELF (with onConnected fired so the conversation resumes);
//   • an exhausted watch lands on an honest stable state, not a stuck spinner;
//   • disconnect without a logout command restores state with a hint;
//   • stable states persist through the store, transients don't.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorService } from '../src/main/connectors.ts';

const SITES = [
  // no login command → the open-tab fallback path
  { site: 'zhihu', domain: 'zhihu.com', commands: 3, authCommands: 2, hasLogin: false, hasWhoami: true },
  { site: 'dianping', domain: 'dianping.com', commands: 2, authCommands: 2, hasLogin: false, hasWhoami: true },
  // ships its own login command → the adapter-driven path
  { site: '12306', domain: '12306.cn', commands: 4, authCommands: 2, hasLogin: true, hasWhoami: true },
  { site: 'arxiv', domain: 'arxiv.org', commands: 1, authCommands: 0, hasLogin: false, hasWhoami: false },
  { site: 'ux', commands: 1, authCommands: 0, hasLogin: false, hasWhoami: false }, // pseudo-adapter
];

function fakeRouter(overrides = {}) {
  const whoamiCalls = [];
  const logoutCalls = [];
  const loginCalls = [];
  return {
    whoamiCalls,
    logoutCalls,
    loginCalls,
    router: {
      listSites: overrides.listSites ?? (async () => SITES),
      whoami: async (site) => {
        whoamiCalls.push(site);
        const impl = overrides.whoami ?? (async () => ({ kind: 'disconnected' }));
        return impl(site, whoamiCalls.length);
      },
      logout: async (site) => {
        logoutCalls.push(site);
        const impl = overrides.logout ?? (async () => ({ supported: false }));
        return impl(site);
      },
      login: async (site, opts) => {
        loginCalls.push({ site, opts });
        const impl = overrides.login ?? (async () => ({ loggedIn: false }));
        return impl(site);
      },
    },
  };
}

function memoryStore(initial = {}) {
  let data = { ...initial };
  return {
    saves: () => data,
    store: {
      load: () => ({ ...data }),
      save: (sites) => {
        data = { ...sites };
      },
    },
  };
}

function harness(overrides = {}) {
  const { router, whoamiCalls, logoutCalls, loginCalls } = fakeRouter(overrides.router ?? {});
  const { store, saves } = memoryStore(overrides.stored ?? {});
  const emitted = [];
  const opened = [];
  const connectedEvents = [];
  let clock = 1_000_000;
  const service = createConnectorService({
    router,
    store,
    emit: (list) => emitted.push(list),
    openTab: (url) => {
      opened.push(url);
      return 'tab-1';
    },
    onConnected: (site, account) => connectedEvents.push({ site, account }),
    now: () => (clock += 1_000),
    sleep: async () => {}, // instant watch ticks
    ...(overrides.deps ?? {}),
  });
  return { service, whoamiCalls, logoutCalls, loginCalls, emitted, opened, connectedEvents, saves };
}

const bySite = (list, site) => list.find((c) => c.site === site);

// ── list ─────────────────────────────────────────────────────────────────────

test('list: merges catalog + cache, filters pseudo-adapters, sorts login-first, no probes', async () => {
  const { service, whoamiCalls } = harness({
    stored: { zhihu: { status: 'connected', account: 'drej', lastChecked: 5 } },
  });
  const list = await service.list();

  assert.deepEqual(
    list.map((c) => c.site),
    ['zhihu', '12306', 'dianping', 'arxiv'],
    'login sites first (connected before unknown), public site last, pseudo-adapter dropped',
  );
  assert.equal(bySite(list, 'zhihu').status, 'connected');
  assert.equal(bySite(list, 'zhihu').account, 'drej');
  assert.equal(bySite(list, 'dianping').status, 'unknown');
  assert.equal(bySite(list, 'arxiv').status, 'none');
  assert.equal(bySite(list, 'arxiv').auth, 'none');
  assert.equal(whoamiCalls.length, 0, 'list() must never spawn a probe');
});

test('list: a stored site still renders when the catalog load fails (degraded boot)', async () => {
  const { service } = harness({
    router: {
      listSites: async () => {
        throw new Error('daemon not reachable');
      },
    },
    stored: { zhihu: { status: 'connected', account: 'drej' } },
  });
  const list = await service.list();
  assert.equal(bySite(list, 'zhihu').status, 'connected');
  assert.equal(bySite(list, 'zhihu').auth, 'login');
});

// ── refresh ──────────────────────────────────────────────────────────────────

test('refresh(site): probes, applies the verdict, persists the stable state', async () => {
  const { service, saves } = harness({
    router: { whoami: async () => ({ kind: 'connected', account: '小明' }) },
  });
  const list = await service.refresh('zhihu');
  const z = bySite(list, 'zhihu');
  assert.equal(z.status, 'connected');
  assert.equal(z.account, '小明');
  assert.ok(z.lastChecked > 0);
  assert.equal(saves().zhihu.status, 'connected');
  assert.equal(saves().zhihu.account, '小明');
});

test('refresh(): probes only stale LOGIN sites — public adapters are never probed', async () => {
  const { service, whoamiCalls } = harness();
  await service.refresh();
  assert.deepEqual([...whoamiCalls].sort(), ['12306', 'dianping', 'zhihu']);
});

test('refresh(): a freshly-checked site is skipped (staleness gate)', async () => {
  const { service, whoamiCalls } = harness();
  await service.refresh('zhihu');
  const before = whoamiCalls.length;
  await service.refresh(); // zhihu just checked → only the others are stale
  assert.deepEqual(whoamiCalls.slice(before).sort(), ['12306', 'dianping']);
});

test('refresh(site): a thrown probe lands on unknown with the error, not a crash', async () => {
  const { service } = harness({
    router: {
      whoami: async () => {
        throw new Error('sandbox exploded');
      },
    },
  });
  const list = await service.refresh('zhihu');
  assert.equal(bySite(list, 'zhihu').status, 'unknown');
  assert.match(bySite(list, 'zhihu').detail, /sandbox exploded/);
});

// ── connect + watch ──────────────────────────────────────────────────────────

test('connect (no login command): opens a www-normalized tab, watch flips to connected + onConnected', async () => {
  let loggedIn = false;
  const { service, opened, connectedEvents, saves } = harness({
    router: {
      whoami: async (_site, n) => {
        // first two watch probes: still signing in; third: landed
        loggedIn = n >= 3;
        return loggedIn
          ? { kind: 'connected', account: 'drej' }
          : { kind: 'disconnected' };
      },
    },
  });

  const list = await service.connect('zhihu');
  // bare apex certs break (https://12306.cn → CERT_COMMON_NAME_INVALID) — the
  // fallback tab must target the www host for two-label domains.
  assert.deepEqual(opened, ['https://www.zhihu.com']);
  assert.equal(bySite(list, 'zhihu').status, 'connecting');

  // the instant-sleep watch loop settles on the microtask queue
  await new Promise((r) => setTimeout(r, 20));
  const after = await service.list();
  assert.equal(bySite(after, 'zhihu').status, 'connected');
  assert.equal(bySite(after, 'zhihu').account, 'drej');
  assert.deepEqual(connectedEvents, [{ site: 'zhihu', account: 'drej' }]);
  assert.equal(saves().zhihu.status, 'connected');
});

test('connect: an exhausted watch lands on disconnected with a hint, never a stuck spinner', async () => {
  const { service, connectedEvents } = harness(); // whoami always disconnected
  await service.connect('zhihu');
  await new Promise((r) => setTimeout(r, 50));
  const after = await service.list();
  assert.equal(bySite(after, 'zhihu').status, 'disconnected');
  assert.match(bySite(after, 'zhihu').detail, /login not detected/);
  assert.equal(connectedEvents.length, 0);
});

test('connect: a domainless site cannot open a tab — honest hint instead', async () => {
  const { service, opened } = harness({
    router: {
      listSites: async () => [
        { site: 'mystery', commands: 1, authCommands: 1, hasLogin: false, hasWhoami: false },
      ],
    },
  });
  const list = await service.connect('mystery');
  assert.deepEqual(opened, []);
  assert.match(bySite(list, 'mystery').detail, /no domain known/);
});

// ── adapter-driven connect (`opencli <site> login`) ──────────────────────────

test('connect (adapter login): drives router.login bounded, no tab of our own, success connects', async () => {
  let resolveLogin;
  const { service, opened, loginCalls, connectedEvents } = harness({
    router: {
      login: () => new Promise((r) => (resolveLogin = r)),
    },
  });
  const list = await service.connect('12306');
  assert.equal(bySite(list, '12306').status, 'connecting');
  assert.deepEqual(opened, [], 'the adapter opens its own login page — never a naive domain tab');
  assert.equal(loginCalls.length, 1);
  assert.equal(loginCalls[0].site, '12306');
  assert.equal(typeof loginCalls[0].opts?.timeoutMs, 'number', 'background login must be bounded');

  resolveLogin({ loggedIn: true, account: '皮皮大魔王' });
  await new Promise((r) => setTimeout(r, 20));
  const after = await service.list();
  assert.equal(bySite(after, '12306').status, 'connected');
  assert.equal(bySite(after, '12306').account, '皮皮大魔王');
  assert.deepEqual(connectedEvents, [{ site: '12306', account: '皮皮大魔王' }]);
});

test('connect (adapter login): a non-success exit defers to a decisive whoami, not login\'s exit', async () => {
  // agent-instructions contract: login often exits with a verify-drift error
  // even though the cookie WAS set — whoami is the truth source.
  const { service, connectedEvents } = harness({
    router: {
      login: async () => ({ loggedIn: false }), // timeout / drift exit
      whoami: async () => ({ kind: 'connected', account: 'drej' }),
    },
  });
  await service.connect('12306');
  await new Promise((r) => setTimeout(r, 20));
  const after = await service.list();
  assert.equal(bySite(after, '12306').status, 'connected');
  assert.equal(connectedEvents.length <= 1, true, 'watch + decisive probe must not double-notify');
});

test('connect (adapter login): a superseded journey (disconnect) drops the late login result', async () => {
  let resolveLogin;
  const { service } = harness({
    router: {
      login: () => new Promise((r) => (resolveLogin = r)),
    },
  });
  await service.connect('12306');
  await service.disconnect('12306'); // cancels the journey (logout unsupported → restores stable)
  resolveLogin({ loggedIn: true, account: 'ghost' });
  await new Promise((r) => setTimeout(r, 20));
  const after = await service.list();
  assert.notEqual(bySite(after, '12306').account, 'ghost', 'a stale journey must not apply');
});

test('watch is bounded by WALL CLOCK, not attempt count (slow probes must not stretch it)', async () => {
  // each now() call advances 30s — the 4-minute deadline exhausts in a few
  // iterations even though the attempt budget alone would allow many more
  let clock = 0;
  const { service, whoamiCalls } = harness({
    deps: { now: () => (clock += 30_000) },
  }); // whoami: always disconnected
  await service.connect('zhihu');
  await new Promise((r) => setTimeout(r, 50));
  const after = await service.list();
  assert.equal(bySite(after, 'zhihu').status, 'disconnected', 'watch must still exhaust honestly');
  assert.ok(
    whoamiCalls.length < 12,
    `wall-clock deadline must bound the watch (saw ${whoamiCalls.length} probes)`,
  );
});

test('a probe landing mid-watch never tears down waiting-for-sign-in (journey-caught race)', async () => {
  // slow watch ticks hold the watch alive while the mid-journey probe lands
  const { service } = harness({
    deps: { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 40))) },
  }); // whoami: always disconnected — the human hasn't scanned yet
  await service.connect('zhihu');
  const list = await service.refresh('zhihu'); // queued auto-refresh / manual Check
  assert.equal(
    bySite(list, 'zhihu').status,
    'connecting',
    'a not-yet verdict must restore the watch-owned badge, not paint Not connected',
  );
  service.dispose();
});

test('a probe that CONFIRMS the login mid-watch notifies exactly once', async () => {
  const { service, connectedEvents } = harness({
    deps: { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 40))) },
    router: { whoami: async () => ({ kind: 'connected', account: 'drej' }) },
  });
  await service.connect('zhihu');
  await service.refresh('zhihu'); // Check lands before the watch's first poll
  await new Promise((r) => setTimeout(r, 150)); // let any surviving watch poll run
  assert.deepEqual(connectedEvents, [{ site: 'zhihu', account: 'drej' }]);
  service.dispose();
});

// ── disconnect ───────────────────────────────────────────────────────────────

test('disconnect: logout supported → logout runs, then a fresh probe tells the truth', async () => {
  const { service, logoutCalls } = harness({
    stored: { zhihu: { status: 'connected', account: 'drej' } },
    router: {
      logout: async () => ({ supported: true }),
      whoami: async () => ({ kind: 'disconnected' }),
    },
  });
  const list = await service.disconnect('zhihu');
  assert.deepEqual(logoutCalls, ['zhihu']);
  assert.equal(bySite(list, 'zhihu').status, 'disconnected');
  assert.equal(bySite(list, 'zhihu').account, undefined);
});

test('disconnect during a connect watch: never restores a transient spinner state', async () => {
  const { service } = harness(); // whoami: always disconnected; logout: unsupported
  await service.connect('zhihu'); // → connecting + watch
  const list = await service.disconnect('zhihu'); // cancels the watch
  const status = bySite(list, 'zhihu').status;
  assert.notEqual(status, 'connecting', 'no watch is running — a spinner here would never end');
  assert.notEqual(status, 'checking');
});

test('disconnect: no logout command → state restored with a sign-out hint', async () => {
  const { service, whoamiCalls } = harness({
    stored: { zhihu: { status: 'connected', account: 'drej' } },
  });
  const list = await service.disconnect('zhihu');
  assert.equal(bySite(list, 'zhihu').status, 'connected', 'unsupported logout must not lie');
  assert.match(bySite(list, 'zhihu').detail, /no logout command/);
  assert.equal(whoamiCalls.length, 0, 'nothing to verify when logout never ran');
});

// ── transitions stream to the renderer ───────────────────────────────────────

test('every transition emits a snapshot (checking → verdict)', async () => {
  const { service, emitted } = harness({
    router: { whoami: async () => ({ kind: 'connected', account: 'drej' }) },
  });
  await service.refresh('zhihu');
  const zhihuStates = emitted.map((list) => bySite(list, 'zhihu')?.status);
  assert.deepEqual(zhihuStates, ['checking', 'connected']);
});
