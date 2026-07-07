/**
 * Pure helpers for the renderer's bounded AgentEvent buffer and its turn
 * tracking. Extracted from useRenderState so the policy is testable without
 * React:
 *
 *  - `appendEvent` merges reasoning fragments, replaces re-emitted ux cards
 *    (stable id, last-wins) and applies the cap;
 *  - `capEvents` evicts the OLDEST non-`ux` events first, so surface cards
 *    (answers, login/confirm, page references) are never flooded out by
 *    process noise;
 *  - `reduceOpenTurns`/`computeOpenTurns` track the set of open turns — busy
 *    is `open.length > 0`, cleared only by turn lifecycle (never by mid-turn
 *    `error` rows), with `sandbox closed` as the crash escape hatch.
 *
 * Everything is immutable: callers get a new array (or the same reference
 * when nothing changed).
 */

import type { AgentEvent } from '@render/protocol';

export const MAX_EVENTS = 300;

/**
 * Evict the oldest non-`ux` events beyond MAX_EVENTS. Ux surfaces are never
 * evicted (they carry irreplaceable affordances: Save, login, confirm), so a
 * buffer made mostly of surfaces may legitimately exceed the cap.
 */
export function capEvents(events: AgentEvent[]): AgentEvent[] {
  let excess = events.length - MAX_EVENTS;
  if (excess <= 0) return events;
  const kept: AgentEvent[] = [];
  for (const e of events) {
    if (excess > 0 && e.kind !== 'ux') {
      excess -= 1;
      continue;
    }
    kept.push(e);
  }
  return kept;
}

/**
 * Append one event to the buffer:
 *  - a `reasoning` fragment merges into a trailing `reasoning` event for the
 *    same item (codex streams reasoning as many tiny deltas — unmerged they
 *    flood the window and evict real content);
 *  - a `ux` message replaces any earlier emission with the same id (the main
 *    process re-emits updated draft cards under a stable id — last wins, at
 *    the last occurrence's position);
 *  - then the cap applies (see capEvents).
 */
export function appendEvent(prev: AgentEvent[], e: AgentEvent): AgentEvent[] {
  const last = prev[prev.length - 1];
  if (e.kind === 'reasoning' && last?.kind === 'reasoning' && last.itemId === e.itemId) {
    return [...prev.slice(0, -1), { ...last, text: last.text + e.text }];
  }
  if (e.kind === 'ux' && prev.some((p) => p.kind === 'ux' && p.message.id === e.message.id)) {
    const withoutStale = prev.filter(
      (p) => !(p.kind === 'ux' && p.message.id === e.message.id),
    );
    return capEvents([...withoutStale, e]);
  }
  return capEvents([...prev, e]);
}

/**
 * Advance the ordered set of open turn ids by one event.
 *
 *  - `turn_started` opens a turn;
 *  - `turn_completed` closes it — by id when the event carries one, else the
 *    OLDEST open turn (back-compat with emitters that don't tag completions);
 *  - `error` events do NOT close turns: they are in-turn feed rows, and
 *    flipping the panel idle on a recoverable hiccup invites a double-submit;
 *  - `sandbox closed` clears everything — a dead agent process will never
 *    emit the matching turn_completed.
 */
export function reduceOpenTurns(open: readonly string[], e: AgentEvent): readonly string[] {
  switch (e.kind) {
    case 'turn_started':
      return open.includes(e.turnId) ? open : [...open, e.turnId];
    case 'turn_completed': {
      if (open.length === 0) return open;
      if (e.turnId) {
        return open.includes(e.turnId) ? open.filter((id) => id !== e.turnId) : open;
      }
      return open.slice(1); // untagged completion → close the oldest open turn
    }
    case 'sandbox':
      return e.status === 'closed' && open.length > 0 ? [] : open;
    default:
      return open;
  }
}

/**
 * Recompute the open-turn set from a replayed event log, so a renderer reload
 * mid-turn comes back showing the working state instead of a false idle.
 */
export function computeOpenTurns(events: readonly AgentEvent[]): readonly string[] {
  return events.reduce(reduceOpenTurns, [] as readonly string[]);
}
