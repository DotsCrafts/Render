/**
 * Smoke test — proves the app hand end-to-end with REAL data.
 *
 *   1. classify real adapters from opencli metadata
 *   2. run a PUBLIC adapter (arxiv/search) through the sandbox → real JSON
 *   3. dry-run the BROWSER route: stand up the real cdp-human-hand relay, point
 *      OPENCLI_CDP_ENDPOINT at it, invoke a cookie adapter → needsLogin (no crash)
 *
 * Run: pnpm --filter @render/opencli-router smoke
 */

import { selectSandbox, describeSelection } from '@render/sandbox';
import { createHumanHand } from '@render/cdp-human-hand';
import { createOpencliRouter } from './index.js';

const line = (s = ''): void => console.log(s);
const hr = (): void => line('─'.repeat(64));

async function main(): Promise<void> {
  line('▶ Render app-hand (opencli-router) smoke');
  line(`  sandbox: ${describeSelection()}`);
  hr();

  // A real human-hand: its cdpEndpoint() stands up the actual local CDP relay.
  // No Electron here, so it has no tabs — exactly the "not logged in" case.
  const humanHand = createHumanHand({
    getTarget: () => undefined,
    createTab: async () => {
      throw new Error('smoke: no Electron tabs available');
    },
    listTabs: () => [],
  });

  const sandbox = selectSandbox();
  const router = createOpencliRouter({ sandbox, humanHand });

  try {
    // 1 ─ real classification from opencli metadata
    const samples: Array<[string, string]> = [
      ['arxiv', 'search'],
      ['12306', 'me'],
      ['zhihu', 'hot'],
    ];
    line('1. classify (from real `opencli list` metadata):');
    for (const [site, command] of samples) {
      line(`   ${site} ${command.padEnd(8)} → ${await router.classify(site, command)}`);
    }
    line(`   catalog loaded: ${router.catalogSize()} commands`);
    hr();

    // 2 ─ PUBLIC adapter through the sandbox → REAL data
    line('2. public adapter via sandbox  →  opencli arxiv search "…" (REAL):');
    const pub = await router.invoke({
      site: 'arxiv',
      command: 'search',
      args: { query: 'retrieval augmented generation', limit: 3 },
      format: 'json',
    });
    line(`   ok=${pub.ok}  strategy=${pub.strategy}  ranOn=${pub.ranOn}`);
    if (!pub.ok || !Array.isArray(pub.data)) {
      throw new Error(`public adapter returned no data: ${pub.error ?? 'unknown'}`);
    }
    const papers = pub.data as Array<{ title?: string; published?: string; url?: string }>;
    for (const p of papers) line(`   • ${p.published}  ${String(p.title).slice(0, 64)}`);
    line(`   ↳ ${papers.length} real papers returned from arXiv`);
    hr();

    // 3 ─ BROWSER route dry-run: real relay endpoint + OPENCLI_CDP_ENDPOINT wiring
    line('3. browser route (cdp-human-hand relay wiring):');
    const endpoint = await router.browserEndpoint();
    line(`   OPENCLI_CDP_ENDPOINT → ${endpoint}`);
    if (endpoint) {
      const version = await fetch(`${endpoint}/json/version`).then((r) => r.json());
      line(`   relay /json/version → ${JSON.stringify(version)}`);
    }
    const browser = await router.invoke({ site: '12306', command: 'me', format: 'json' });
    line(`   invoke 12306 me → ok=${browser.ok} ranOn=${browser.ranOn}`);
    if (browser.needsLogin) {
      line(`   needsLogin → site=${browser.needsLogin.site} loginUrl=${browser.needsLogin.loginUrl}`);
    }
    hr();

    const pass = pub.ok && Array.isArray(pub.data) && papers.length > 0 && Boolean(endpoint);
    line(pass ? '✅ SMOKE PASS — real public data + browser-route wiring verified' : '❌ SMOKE FAIL');
    if (!pass) process.exitCode = 1;
  } finally {
    await router.dispose().catch(() => undefined);
    await humanHand.dispose().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('smoke error:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
