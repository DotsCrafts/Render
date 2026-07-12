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
  { site: 'zhihu', domain: 'zhihu.com', commands: 3, authCommands: 2 },
  { site: 'dianping', domain: 'dianping.com', commands: 2, authCommands: 2 },
  { site: 'arxiv', domain: 'arxiv.org', commands: 1, authCommands: 0 },
  { site: 'ux', commands: 1, authCommands: 0 }, // pseudo-adapter: no domain, no auth
];

function fakeRouter(overrides = {}) {
  const whoamiCalls = [];
  const logoutCalls = [];
  return {
    whoamiCalls,
    logoutCalls,
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
  const { router, whoamiCalls, logoutCalls } = fakeRouter(overrides.router ?? {});
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
  return { service, whoamiCalls, logoutCalls, emitted, opened, connectedEvents, saves };
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
    ['zhihu', 'dianping', 'arxiv'],
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
  assert.deepEqual([...whoamiCalls].sort(), ['dianping', 'zhihu']);
});

test('refresh(): a freshly-checked site is skipped (staleness gate)', async () => {
  const { service, whoamiCalls } = harness();
  await service.refresh('zhihu');
  const before = whoamiCalls.length;
  await service.refresh(); // zhihu just checked → only dianping is stale
  assert.deepEqual(whoamiCalls.slice(before), ['dianping']);
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

test('connect: opens https://<domain>, goes connecting, watch flips to connected + onConnected', async () => {
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
  assert.deepEqual(opened, ['https://zhihu.com']);
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
    router: { listSites: async () => [{ site: 'mystery', commands: 1, authCommands: 1 }] },
  });
  const list = await service.connect('mystery');
  assert.deepEqual(opened, []);
  assert.match(bySite(list, 'mystery').detail, /no domain known/);
});

test('noteLoginOpened: starts the same watch without opening another tab', async () => {
  let landed = false;
  const { service, opened, connectedEvents } = harness({
    router: {
      whoami: async () => (landed ? { kind: 'connected', account: 'drej' } : { kind: 'disconnected' }),
    },
  });
  service.noteLoginOpened('dianping');
  const list = await service.list();
  assert.equal(bySite(list, 'dianping').status, 'connecting');
  assert.deepEqual(opened, [], 'the runtime already opened the tab');

  landed = true;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(connectedEvents, [{ site: 'dianping', account: 'drej' }]);
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
