/**
 * M2 smoke proof: start codex app-server inside a SandboxProvider, run ONE real
 * turn, and print the streamed AgentEvents.
 *
 *   pnpm --filter @render/agent-bridge smoke
 *   pnpm --filter @render/agent-bridge smoke "say hello in 3 words"
 *
 * Selects e2b when E2B_API_KEY is set, else the keyless local-seatbelt default.
 * Exits 0 only if a real `turn/completed` with status=completed comes back.
 */

import { selectSandbox, describeSelection } from '@render/sandbox';
import type { AgentEvent } from '@render/protocol';
import { AgentSession } from './agent-session.js';

const PROMPT = process.argv.slice(2).join(' ') || 'say hello in 3 words';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);

async function main(): Promise<number> {
  // local-seatbelt boots the brain via codex's own OS sandbox; force it unless
  // a key explicitly opts into e2b (which needs codex baked into the template).
  const sandbox = selectSandbox({ prefer: process.env.E2B_API_KEY ? undefined : 'local-seatbelt' });
  process.stderr.write(`[smoke] sandbox: ${describeSelection()} → ${sandbox.id}\n`);
  process.stderr.write(`[smoke] prompt: ${JSON.stringify(PROMPT)}\n`);

  const session = new AgentSession({
    sandbox,
    approvalPolicy: 'never', // smoke stays hands-off; no HITL round-trip needed
    sandboxMode: 'workspace-write',
    effort: 'low',
  });

  const events: AgentEvent[] = [];
  let finalText = '';
  let completedStatus = '';

  session.onAgentEvent((e) => {
    events.push(e);
    switch (e.kind) {
      case 'sandbox':
        process.stderr.write(`[event] sandbox.${e.status} (${e.provider})\n`);
        break;
      case 'turn_started':
        process.stderr.write(`[event] turn_started ${e.turnId}\n`);
        break;
      case 'delta':
        process.stderr.write(e.text);
        break;
      case 'item':
        if (e.phase === 'completed' && e.item.type === 'agentMessage' && e.item.text)
          finalText = e.item.text;
        process.stderr.write(`\n[event] item.${e.phase} ${e.item.type}\n`);
        break;
      case 'turn_completed':
        completedStatus = e.status;
        process.stderr.write(`[event] turn_completed ${e.status} (${e.durationMs ?? '?'}ms)\n`);
        break;
      case 'error':
        process.stderr.write(`[event] error ${e.message}\n`);
        break;
      default:
        break;
    }
  });

  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`smoke timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
  );

  const result: Record<string, unknown> = { ok: false, provider: sandbox.id, prompt: PROMPT };
  try {
    const started = await Promise.race([session.start(), deadline]);
    result.model = started.model;
    result.modelProvider = started.modelProvider;
    result.threadId = started.thread.id;

    const turnDone = new Promise<string>((resolve) => {
      const off = session.onAgentEvent((e) => {
        if (e.kind === 'turn_completed') {
          off();
          resolve(e.status);
        }
      });
    });

    const { turnId } = await session.submitTurn(PROMPT);
    result.turnId = turnId;
    const status = await Promise.race([turnDone, deadline]);

    result.turnStatus = status;
    result.agentText = finalText;
    result.eventKinds = countBy(events.map((e) => e.kind));
    result.ok = status === 'completed';
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    await session.dispose();
  }

  process.stderr.write('\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.ok ? 0 : 1;
}

function countBy(arr: string[]): Record<string, number> {
  return arr.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`[smoke] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  },
);
