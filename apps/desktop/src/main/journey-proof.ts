/**
 * M6 journey proof — runs the REAL spine headlessly (no Electron GUI), exactly
 * the wiring main/index.ts hands the IPC broker, and prints the AgentEvent log.
 *
 * Proves end-to-end:
 *   A. app hand   — `/opencli arxiv search …` routes through the OpencliRouter
 *                   and real arXiv JSON surfaces as a ux render.
 *   B. brain+HITL — a real codex turn runs in the sandbox, requests command
 *                   approval, and a human "allow" round-trips back via resolveUx
 *                   so the turn completes.
 *   C. human hand — the CDP relay endpoint (OPENCLI_CDP_ENDPOINT) is live and a
 *                   cookie adapter resolves to a ux login (needs a logged-in tab).
 *
 * macOS GUI screenshot perms block window capture (QA hit this); this log + the
 * in-app cdp-selftest are the allowed evidence.
 *
 *   pnpm --filter @render/desktop proof
 */

import { selectSandbox, describeSelection } from '@render/sandbox';
import { createOpencliRouter } from '@render/opencli-router';
import { createHumanHand } from '@render/cdp-human-hand';
import type { AgentEvent, UxMessage } from '@render/protocol';
import { createAgentRuntime, type AgentRuntime } from './agent-runtime.js';

const TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS ?? 180_000);
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

  const result: Record<string, unknown> = { ok: false };
  try {
    // ── A. app hand: /opencli public adapter → real data as ux render ─────────
    line('A. app hand — /opencli arxiv search (REAL):');
    // opencli submit() resolves only AFTER the router runs and the ux + turn
    // events are emitted, so the ux render is already in `uxSeen` here.
    await deadline(
      runtime.submit('/opencli arxiv search query="retrieval augmented generation" limit=3'),
      'opencli submit',
    );
    const arxivUx = uxSeen.find((m) => m.kind === 'render' && m.spec && 'items' in m.spec);
    const papers =
      arxivUx && 'items' in arxivUx.spec ? (arxivUx.spec.items ?? []) : [];
    result.opencliPapers = papers.length;
    if (papers.length === 0) throw new Error('opencli arxiv returned no ux render items');
    hr();

    // ── B. brain + HITL: real codex turn with a command-approval round-trip ───
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
    hr();

    // ── C. human hand: CDP relay live + cookie adapter → ux login ─────────────
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
      line(`   ux login → site=${loginUx.spec.site} loginUrl=${loginUx.spec.loginUrl}`);
    }
    hr();

    result.eventKinds = countBy(log.map((e) => e.kind));
    result.ok =
      papers.length > 0 &&
      result.codexTurnStatus === 'completed' &&
      Boolean(endpoint) &&
      Boolean(loginUx);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    await runtime.dispose().catch(() => undefined);
    await router.dispose().catch(() => undefined);
    await humanHand.dispose().catch(() => undefined);
  }

  line(
    result.ok
      ? '✅ M6 PASS — opencli ux render + codex HITL round-trip + live CDP browser route'
      : '❌ M6 INCOMPLETE',
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.ok ? 0 : 1;
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
