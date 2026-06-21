/**
 * agent-stub — a TEMPORARY fake AgentEvent producer so the renderer panel + IPC
 * stream are exercisable end-to-end before the real bridge lands.
 *
 * TODO(bridge): Worker Sandbox / Worker Bridge own packages/agent-bridge, which
 * spawns codex in the sandbox and maps codex events → AgentEvent. This module is
 * deleted then; the IPC SHAPES here already match protocol exactly so the swap
 * is drop-in (emit the same AgentEvent union over the same channel).
 */

import type { AgentEvent, UxMessage } from '@render/protocol';

export interface AgentStub {
  submit(text: string): { turnId: string };
  steer(text: string): void;
  cancel(): void;
  resolveUx(id: string, result: unknown): void;
  dispose(): void;
}

export interface AgentStubDeps {
  emit: (event: AgentEvent) => void;
  now: () => number;
}

export function createAgentStub(deps: AgentStubDeps): AgentStub {
  let turnSeq = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const pendingUx = new Set<string>();

  const at = (ms: number, fn: () => void): void => {
    timers = [...timers, setTimeout(fn, ms)];
  };

  const clearTimers = (): void => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };

  const submit = (text: string): { turnId: string } => {
    clearTimers();
    const turnId = `turn-${++turnSeq}`;
    const itemId = `${turnId}-msg`;

    deps.emit({ kind: 'turn_started', turnId });
    deps.emit({ kind: 'sandbox', status: 'spawning', provider: 'local-seatbelt' });

    at(120, () => deps.emit({ kind: 'sandbox', status: 'ready', provider: 'local-seatbelt' }));
    at(200, () =>
      deps.emit({ kind: 'reasoning', itemId: `${itemId}-r`, text: 'Parsing the request…' }),
    );
    at(420, () =>
      deps.emit({ kind: 'item', phase: 'started', item: { id: itemId, type: 'agentMessage' } }),
    );

    const reply = `You said: "${text}". (stub agent — the real codex bridge lands in M2.)`;
    reply.split(' ').forEach((word, i) => {
      at(560 + i * 45, () => deps.emit({ kind: 'delta', itemId, text: `${word} ` }));
    });
    const settle = 560 + reply.split(' ').length * 45 + 120;

    at(settle, () =>
      deps.emit({
        kind: 'item',
        phase: 'completed',
        item: { id: itemId, type: 'agentMessage', text: reply },
      }),
    );
    at(settle + 80, () => deps.emit({ kind: 'ux', message: demoRender(text, deps.now()) }));
    at(settle + 160, () => deps.emit({ kind: 'turn_completed', status: 'completed', durationMs: settle }));

    return { turnId };
  };

  const steer = (text: string): void => {
    deps.emit({ kind: 'delta', text: `\n↳ steer: ${text}\n` });
  };

  const cancel = (): void => {
    clearTimers();
    deps.emit({ kind: 'turn_completed', status: 'cancelled' });
  };

  const resolveUx = (id: string): void => {
    pendingUx.delete(id);
  };

  const dispose = (): void => {
    clearTimers();
    pendingUx.clear();
  };

  return { submit, steer, cancel, resolveUx, dispose };
}

const demoRender = (text: string, ts: number): UxMessage<'render'> => ({
  id: `ux-${ts}`,
  kind: 'render',
  blocking: false,
  ts,
  spec: {
    title: 'Stub result',
    body: 'This card proves the agent panel renders structured `ux render` specs over IPC.',
    items: [
      { title: 'Echoed prompt', subtitle: text, fields: { kind: 'render', source: 'agent-stub' } },
    ],
  },
});
