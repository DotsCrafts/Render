/**
 * Journey proof — runs the REAL spine headlessly (no Electron GUI), close to
 * the wiring main/index.ts hands the IPC broker, and prints the AgentEvent log.
 *
 * Proves end-to-end:
 *   A. app hand   — `/opencli arxiv search …` routes through the OpencliRouter
 *                   and real arXiv JSON surfaces as a ux render.
 *   B. brain+HITL — a real codex turn runs in the sandbox, requests command
 *                   approval, a human "allow" round-trips back via resolveUx,
 *                   AND the approved command demonstrably EXECUTED (a completed
 *                   commandExecution with exit 0) — both are load-bearing in
 *                   result.ok, so an approval-protocol drift (the B1 precedent)
 *                   fails the proof instead of passing vacuously.
 *   C. human hand — the CDP relay endpoint (OPENCLI_CDP_ENDPOINT) is live and a
 *                   cookie adapter resolves to a ux login (needs a logged-in tab).
<<<<<<< HEAD
 *   D. page write — a generated page served via runtime.servePage (opencli-ux
 *                   kernel, --keep): /ux/config carries keep:true; a write-granted
 *                   /ux/data call is brokered through the ux-confirm-broker (the
 *                   human's "允许" resolves it via resolveUx); a ux_submit callback
 *                   streams back as JSONL and is forwarded into the conversation
 *                   as the agent's next turn — the page→action→agent round-trip.
=======
 *   D. generated page — a fixture json-render spec is served through the SAME
 *                   ux-server kernel render-page uses; the URL must answer 200,
 *                   /ux/data must run an allowlisted read and 403 a
 *                   non-allowlisted one, and spec-guard must reject a terminal
 *                   ux_submit binding.
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
 *
 * macOS GUI screenshot perms block window capture (QA hit this); this log + the
 * in-app cdp-selftest are the allowed evidence.
 *
 *   pnpm --filter @render/desktop proof
 *   PROOF_STEPS=D pnpm --filter @render/desktop proof   # run a subset (A–D)
 */

import { execFile } from 'node:child_process';
import { selectSandbox, describeSelection } from '@render/sandbox';
import { createOpencliRouter } from '@render/opencli-router';
import { createHumanHand } from '@render/cdp-human-hand';
import type { AgentEvent, UxMessage, UxLoginSpec } from '@render/protocol';
import { createAgentRuntime, type AgentRuntime } from './agent-runtime.js';
import { serveUxSpec } from './ux-server.js';
import { validatePageSpec } from './spec-guard.js';

const TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS ?? 180_000);
// Which journey steps to run (default: all). e.g. PROOF_STEPS=D → page write only.
const STEPS = new Set(
  (process.env.PROOF_STEPS ?? 'ABCD').toUpperCase().split('').filter((c) => 'ABCD'.includes(c)),
);
const line = (s = ''): void => console.log(s);
const hr = (): void => line('─'.repeat(68));

function deadline<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label} (${TIMEOUT_MS}ms)`)), TIMEOUT_MS),
    ),
  ]);
}

async function main(): Promise<number> {
  line('▶ Render M6 — real spine journey proof');
  line(`  sandbox: ${describeSelection()}`);
  hr();

  // Headless human-hand: no Electron tabs, but its cdpEndpoint() stands up the
  // real local CDP relay — the exact "not logged in" browser-route condition.
  const humanHand = createHumanHand({
    getTarget: () => undefined,
    createTab: async () => {
      throw new Error('proof: no Electron tabs (headless)');
    },
    listTabs: () => [],
  });

  const router = createOpencliRouter({ sandbox: selectSandbox(), humanHand });

  const log: AgentEvent[] = [];
  const uxSeen: UxMessage[] = [];
  const resolvedUx = new Set<string>();
  let runtime: AgentRuntime | null = null;

  const onEvent = (e: AgentEvent): void => {
    log.push(e);
    if (e.kind === 'ux') {
      uxSeen.push(e.message);
      printUx(e.message);
      // Act as the human: approve the FIRST blocking confirm so the turn proceeds.
      if (
        e.message.blocking &&
        e.message.kind === 'confirm' &&
        !resolvedUx.has(e.message.id) &&
        runtime
      ) {
        resolvedUx.add(e.message.id);
        line(`   ⮑  human approves confirm ${e.message.id} → ux_confirm "允许"`);
        void runtime.resolveUx(e.message.id, { action: 'ux_confirm', choice: '允许' });
      }
    } else if (e.kind === 'delta') {
      process.stderr.write(e.text);
    } else if (e.kind === 'sandbox') {
      line(`   · sandbox.${e.status} (${e.provider})`);
    } else if (e.kind === 'turn_completed') {
      line(`   · turn_completed: ${e.status}`);
    } else if (e.kind === 'error') {
      line(`   ! error: ${e.message}`);
    }
  };

  runtime = createAgentRuntime({
    emit: onEvent,
    sandbox: selectSandbox(),
    router,
    now: () => Date.now(),
    // `untrusted` forces codex to ask before every command → guarantees a real
    // HITL confirm round-trip for the proof.
    approvalPolicy: 'untrusted',
    sandboxMode: 'workspace-write',
    effort: 'low',
  });

  const result: Record<string, unknown> = { ok: false, steps: [...STEPS].sort().join('') };
  const passed: Record<string, boolean> = {};
  try {
    if (STEPS.has('A')) {
      // ── A. app hand: /opencli public adapter → real data as ux render ───────
      line('A. app hand — /opencli arxiv search (REAL):');
      // opencli submit() resolves only AFTER the router runs and the ux + turn
      // events are emitted, so the ux render is already in `uxSeen` here.
      await deadline(
        runtime.submit('/opencli arxiv search query="retrieval augmented generation" limit=3'),
        'opencli submit',
      );
      const arxivUx = uxSeen.find((m) => m.kind === 'render' && m.spec && 'items' in m.spec);
      const papers = arxivUx && 'items' in arxivUx.spec ? (arxivUx.spec.items ?? []) : [];
      result.opencliPapers = papers.length;
      if (papers.length === 0) throw new Error('opencli arxiv returned no ux render items');
      passed.A = true;
      hr();
    }

<<<<<<< HEAD
    if (STEPS.has('B')) {
      // ── B. brain + HITL: real codex turn with a command-approval round-trip ─
      line('B. brain — codex turn that asks command approval (HITL round-trip):');
      const turnDone = waitFor(log, (e) => e.kind === 'turn_completed');
      await deadline(
        runtime.submit(
          'Run the shell command `date -u` to get the current UTC time, then tell me exactly what it printed. You must run it as a command.',
        ),
        'codex submit',
      );
      const completion = await deadline(turnDone, 'codex turn_completed');
      process.stderr.write('\n');
      const confirmRoundTrip = resolvedUx.size > 0;
      result.codexTurnStatus = completion.kind === 'turn_completed' ? completion.status : 'unknown';
      result.confirmRoundTrip = confirmRoundTrip;
      if (!confirmRoundTrip) {
        line('   (note: codex completed without requesting approval this run)');
      }
      passed.B = result.codexTurnStatus === 'completed';
      hr();
    }
=======
    // ── B. brain + HITL: real codex turn with a command-approval round-trip ───
    line('B. brain — codex turn that asks command approval (HITL round-trip):');
    // NOT the synthetic boot-N turn the runtime retires as soon as codex's real
    // turn starts — the proof must observe the REAL turn's completion.
    const turnDone = waitFor(
      log,
      (e) => e.kind === 'turn_completed' && !(typeof e.turnId === 'string' && e.turnId.startsWith('boot-')),
    );
    await deadline(
      runtime.submit(
        'Run the shell command `date -u` to get the current UTC time, then tell me exactly what it printed. You must run it as a command.',
      ),
      'codex submit',
    );
    const completion = await deadline(turnDone, 'codex turn_completed');
    process.stderr.write('\n');
    // The round-trip is only real if (a) an approval was surfaced AND replied to
    // and (b) the approved command demonstrably RAN — B1 taught us a mangled
    // decision reply lets the turn "complete" while the command never executes.
    const confirmRoundTrip = resolvedUx.size > 0;
    const approvedCommandRan = log.some(
      (e) =>
        e.kind === 'item' &&
        e.phase === 'completed' &&
        e.item.type === 'commandExecution' &&
        /date(\s+-u)?/.test(String(e.item.command ?? '')) &&
        e.item.exitCode === 0,
    );
    result.codexTurnStatus = completion.kind === 'turn_completed' ? completion.status : 'unknown';
    result.confirmRoundTrip = confirmRoundTrip;
    result.approvedCommandRan = approvedCommandRan;
    result.codexVersion = await codexVersion();
    if (!confirmRoundTrip) line('   ✗ codex completed WITHOUT requesting approval — HITL unproven');
    if (!approvedCommandRan) line('   ✗ no completed `date` commandExecution with exit 0 observed');
    hr();
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e

    if (STEPS.has('C')) {
      // ── C. human hand: CDP relay live + cookie adapter → ux login ───────────
      line('C. human hand — CDP relay + browser route:');
      const endpoint = await router.browserEndpoint();
      result.cdpEndpoint = endpoint;
      line(`   OPENCLI_CDP_ENDPOINT → ${endpoint}`);
      if (endpoint) {
        const version = await fetch(`${endpoint}/json/version`).then((r) => r.json());
        line(`   relay /json/version → ${JSON.stringify(version)}`);
      }
      await deadline(runtime.submit('/opencli 12306 me'), 'opencli browser route');
      const loginUx = uxSeen.find((m) => m.kind === 'login');
      result.browserRouteLogin = Boolean(loginUx);
      if (loginUx && loginUx.kind === 'login') {
        const login = loginUx.spec as UxLoginSpec;
        line(`   ux login → site=${login.site} loginUrl=${login.loginUrl}`);
      }
      passed.C = Boolean(endpoint) && Boolean(loginUx);
      hr();
    }

    if (STEPS.has('D')) {
      // ── D. page write path: generated page → action → agent round-trip ──────
      line('D. page write path — keep-mode page, brokered write, action round-trip:');
      // A minimal page with one submit button — served through the runtime so it
      // gets the spec-guard, the write-confirm broker, and callback forwarding.
      const specJson = JSON.stringify({
        root: 'root',
        state: {},
        elements: {
          root: { type: 'Stack', props: { direction: 'vertical', gap: 'md' }, children: ['btn'] },
          btn: { type: 'Button', props: { label: '提交' }, on: { press: { action: 'ux_submit' } } },
        },
      });
      const page = await runtime.servePage({
        specJson,
        title: 'proof-page',
        allow: '',
        allowWrite: 'arxiv search', // per-command write grant (harmless read used as the granted command)
      });
      const pageUrl = await deadline(page.whenReady(), 'page url');
      if (!pageUrl) throw new Error('page never announced a url (is opencli-ux/ux.mjs present?)');
      line(`   page served → ${pageUrl}`);
      const cfg = (await (await fetch(new URL('/ux/config', pageUrl))).json()) as {
        keep?: boolean;
        session: string;
        token: string;
        allowWrite?: string[];
      };
      if (cfg.keep !== true) throw new Error('/ux/config missing keep:true');
      result.pageConfigKeep = true;
      line(`   /ux/config → keep:true, allowWrite:${JSON.stringify(cfg.allowWrite)}`);

      // write-granted /ux/data: the kernel asks Render's confirm broker; the
      // blocking confirm card is auto-approved above (the "human" allows) and
      // the command runs. Anything but a write_denied/not_allowlisted proves
      // the brokered path.
      const dataRes = (await (
        await fetch(new URL('/ux/data', pageUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ux-token': cfg.token },
          body: JSON.stringify({ site: 'arxiv', command: 'search', positional: [], args: { query: 'agents', limit: 1 } }),
        })
      ).json()) as { ok?: boolean; code?: string; error?: string };
      const brokered = dataRes.code !== 'write_denied' && dataRes.code !== 'not_allowlisted';
      result.pageWriteBrokered = brokered;
      line(`   /ux/data (write-granted) → ok:${dataRes.ok} code:${dataRes.code ?? '-'}`);
      if (!brokered) throw new Error(`write was not brokered: ${dataRes.error ?? dataRes.code}`);

      // page action → agent: post the ux_submit callback like the page would;
      // the kernel streams it as JSONL, the runtime forwards it into the
      // conversation ([page action] …) and a real turn answers it.
      const echoed = waitFor(
        log,
        (e) =>
          e.kind === 'item' &&
          (e as { item?: { type?: string; text?: unknown } }).item?.type === 'userMessage' &&
          String((e as { item?: { text?: unknown } }).item?.text ?? '').includes('[page action]'),
      );
      const answered = waitFor(log, (e) => e.kind === 'turn_completed');
      await fetch(new URL(`/ux/callback/${cfg.session}`, pageUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ux-token': cfg.token },
        body: JSON.stringify({ submitted: true, action: 'ux_submit', values: { q: '42' } }),
      });
      await deadline(echoed, 'page action forwarded into the conversation');
      line('   ux_submit callback → forwarded as [page action] turn input');
      const turn = await deadline(answered, 'page-action turn completed');
      process.stderr.write('\n');
      result.pageActionTurnStatus = turn.kind === 'turn_completed' ? turn.status : 'unknown';
      result.pageActionRoundTrip = true;
      page.dispose();
      passed.D = brokered && result.pageActionTurnStatus === 'completed';
      hr();
    }

    // ── D. generated page: the render-page kernel serves + gates a spec ───────
    line('D. generated page — ux-server kernel + /ux/data allowlist gate:');
    const pageChecks = await deadline(provePageKernel(), 'page kernel proof');
    Object.assign(result, pageChecks);
    line(`   served=${pageChecks.pageServed} data200=${pageChecks.pageDataAllowed} 403=${pageChecks.pageDataRejected} guard=${pageChecks.specGuardRejects}`);
    hr();

    result.eventKinds = countBy(log.map((e) => e.kind));
<<<<<<< HEAD
    result.passed = passed;
    result.ok = [...STEPS].every((s) => passed[s] === true);
=======
    result.ok =
      papers.length > 0 &&
      result.codexTurnStatus === 'completed' &&
      confirmRoundTrip &&
      approvedCommandRan &&
      Boolean(endpoint) &&
      Boolean(loginUx) &&
      pageChecks.pageServed &&
      pageChecks.pageDataAllowed &&
      pageChecks.pageDataRejected &&
      pageChecks.specGuardRejects;
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    await runtime.dispose().catch(() => undefined);
    await router.dispose().catch(() => undefined);
    await humanHand.dispose().catch(() => undefined);
  }

  line(
    result.ok
<<<<<<< HEAD
      ? `✅ M6 PASS — steps ${[...STEPS].sort().join('')} (opencli ux render / codex HITL / CDP route / page write round-trip)`
      : '❌ M6 INCOMPLETE',
=======
      ? '✅ PASS — opencli ux render + codex HITL (approved command ran) + live CDP browser route + generated-page kernel'
      : '❌ INCOMPLETE',
>>>>>>> 0331304119c938cb49ca9d4ba93e575e9a428b5e
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.ok ? 0 : 1;
}

/** Best-effort `codex --version` for approval-protocol drift triage (B1). */
function codexVersion(): Promise<string> {
  return new Promise((resolve) => {
    execFile('codex', ['--version'], { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? `unknown (${err.message.slice(0, 60)})` : stdout.trim());
    });
  });
}

/**
 * Step D: pipe a fixture spec through the SAME kernel render-page uses and
 * probe the served app's contract — 200 on GET /, an allowlisted /ux/data read
 * succeeds, a non-allowlisted one 403s, and spec-guard rejects a terminal
 * ux_submit binding at deliver time.
 */
async function provePageKernel(): Promise<{
  pageServed: boolean;
  pageDataAllowed: boolean;
  pageDataRejected: boolean;
  specGuardRejects: boolean;
}> {
  const fixture = {
    root: 'root',
    state: { status: { papers: 'idle' }, error: {}, data: {} },
    elements: {
      root: { type: 'Stack', props: { direction: 'vertical', gap: 'md' }, children: ['h', 'feed'] },
      h: { type: 'Heading', props: { text: 'proof fixture', level: 'h2' } },
      feed: {
        type: 'FeedList',
        props: { title: 'papers', status: { $state: '/status/papers' }, data: { $state: '/data/papers' } },
        on: {
          mount: {
            action: 'ux_data',
            params: {
              key: 'papers',
              request: { site: 'arxiv', command: 'search', positional: ['agents'], args: { limit: 2 } },
            },
          },
        },
      },
    },
  };
  const specJson = JSON.stringify(fixture);

  // deliver-time guard: a terminal action must be rejected before serving
  const badSpec = JSON.stringify({
    root: 'b',
    elements: { b: { type: 'Button', props: { label: 'x' }, on: { press: { action: 'ux_submit' } } } },
  });
  const specGuardRejects = !validatePageSpec(badSpec, 'arxiv search').ok;

  const page = serveUxSpec({ specJson, allow: 'arxiv search', idTag: `proof-${Date.now()}` });
  try {
    const url = await page.whenReady();
    if (!url) return { pageServed: false, pageDataAllowed: false, pageDataRejected: false, specGuardRejects };
    const origin = new URL(url).origin;
    const pageServed = (await fetch(url)).status === 200;
    const cfg = (await fetch(`${origin}/ux/config`).then((r) => r.json())) as { token?: string };
    const post = (body: unknown): Promise<Response> =>
      fetch(`${origin}/ux/data`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ux-token': cfg.token ?? '',
          origin,
        },
        body: JSON.stringify(body),
      });
    const allowedRes = await post({ site: 'arxiv', command: 'search', positional: ['agents'], args: { limit: 2 } });
    const rejectedRes = await post({ site: 'zhihu', command: 'hot' });
    return {
      pageServed,
      pageDataAllowed: allowedRes.status === 200,
      pageDataRejected: rejectedRes.status === 403,
      specGuardRejects,
    };
  } finally {
    page.dispose();
  }
}

function printUx(m: UxMessage): void {
  if (m.kind === 'render' && 'items' in m.spec) {
    line(`   ux render: ${m.spec.title ?? ''} — ${(m.spec.items ?? []).length} item(s)`);
    for (const it of m.spec.items ?? []) line(`     • ${String(it.title ?? it.subtitle ?? '').slice(0, 72)}`);
  } else {
    line(`   ux ${m.kind}${m.blocking ? ' (blocking)' : ''}`);
  }
}

/** Resolve once an event matching the predicate is appended to the log. */
function waitFor(log: AgentEvent[], pred: (e: AgentEvent) => boolean): Promise<AgentEvent> {
  return new Promise((resolve) => {
    const start = log.length;
    const tick = (): void => {
      for (let i = start; i < log.length; i++) {
        if (pred(log[i])) return resolve(log[i]);
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function countBy(arr: string[]): Record<string, number> {
  return arr.reduce<Record<string, number>>((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {});
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('proof fatal:', e instanceof Error ? e.stack : String(e));
    process.exit(1);
  },
);
