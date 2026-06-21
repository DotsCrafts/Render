/**
 * foldEvents — pure reducer turning the raw AgentEvent IPC stream into readable
 * panel rows. Streaming deltas are coalesced into the message row they belong
 * to so the panel reads like a transcript rather than a token firehose.
 */

import type { AgentEvent, CodexItem, UxMessage } from '@render/protocol';

export type Row =
  | { kind: 'text'; key: string; tone: string; label: string; text: string }
  | { kind: 'ux'; key: string; message: UxMessage };

interface Acc {
  rows: Row[];
  // itemId → index of the message row currently accumulating deltas
  messageIndex: Map<string, number>;
}

const itemLabel = (item: CodexItem): string => item.type;

export function foldEvents(events: AgentEvent[]): Row[] {
  const acc: Acc = { rows: [], messageIndex: new Map() };

  events.forEach((e, i) => {
    const key = `${i}`;
    switch (e.kind) {
      case 'turn_started':
        push(acc, { kind: 'text', key, tone: 'sandbox', label: 'turn started', text: e.turnId });
        break;
      case 'sandbox':
        push(acc, {
          kind: 'text',
          key,
          tone: 'sandbox',
          label: `sandbox · ${e.status}`,
          text: e.provider,
        });
        break;
      case 'reasoning':
        push(acc, { kind: 'text', key, tone: 'reasoning', label: 'reasoning', text: e.text });
        break;
      case 'item': {
        const id = e.item.id;
        if (e.phase === 'started' && e.item.type === 'agentMessage' && id) {
          acc.messageIndex.set(id, acc.rows.length);
          push(acc, { kind: 'text', key, tone: 'message', label: itemLabel(e.item), text: '' });
        } else if (e.phase === 'completed') {
          const idx = id ? acc.messageIndex.get(id) : undefined;
          if (idx !== undefined && e.item.text) {
            const row = acc.rows[idx];
            if (row.kind === 'text') acc.rows[idx] = { ...row, text: e.item.text };
          } else {
            push(acc, {
              kind: 'text',
              key,
              tone: 'message',
              label: itemLabel(e.item),
              text: e.item.text ?? '',
            });
          }
        }
        break;
      }
      case 'delta': {
        const idx = e.itemId ? acc.messageIndex.get(e.itemId) : undefined;
        if (idx !== undefined) {
          const row = acc.rows[idx];
          if (row.kind === 'text') acc.rows[idx] = { ...row, text: row.text + e.text };
        } else {
          push(acc, { kind: 'text', key, tone: 'message', label: 'delta', text: e.text });
        }
        break;
      }
      case 'ux':
        push(acc, { kind: 'ux', key, message: e.message });
        break;
      case 'turn_completed':
        push(acc, {
          kind: 'text',
          key,
          tone: 'sandbox',
          label: `turn ${e.status}`,
          text: e.durationMs ? `${e.durationMs}ms` : '',
        });
        break;
      case 'error':
        push(acc, { kind: 'text', key, tone: 'error', label: 'error', text: e.message });
        break;
    }
  });

  return acc.rows;
}

function push(acc: Acc, row: Row): void {
  acc.rows = [...acc.rows, row];
}
