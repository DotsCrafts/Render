/**
 * Unit tests for the renderer's AgentEvent buffer policy (electron-free).
 *
 * Guards the fixes for:
 *  - busy-flag-misreports: busy is a SET of open turnIds — errors don't clear
 *    it, sandbox-closed clears all, replay recomputes it;
 *  - delta-flood-evicts-cards: reasoning fragments merge on append and the
 *    cap evicts oldest NON-ux events first, so surface cards survive floods.
 *
 * Runs via the desktop unit runner:  node test/run.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EVENTS,
  appendEvent,
  capEvents,
  computeOpenTurns,
  reduceOpenTurns,
} from '../src/renderer/src/agent-event-buffer.ts';

const reasoning = (text, itemId) => ({ kind: 'reasoning', text, ...(itemId ? { itemId } : {}) });
const ux = (id) => ({
  kind: 'ux',
  message: { id, kind: 'render', blocking: false, spec: { body: id }, ts: 0 },
});
const started = (turnId) => ({ kind: 'turn_started', turnId });
const completed = (turnId) => ({
  kind: 'turn_completed',
  status: 'completed',
  ...(turnId ? { turnId } : {}),
});

// ── appendEvent: reasoning merge ─────────────────────────────────────────────

test('consecutive reasoning fragments for the same item merge into one event', () => {
  let buf = [];
  buf = appendEvent(buf, reasoning('think', 'r1'));
  buf = appendEvent(buf, reasoning('ing…', 'r1'));
  assert.equal(buf.length, 1);
  assert.equal(buf[0].text, 'thinking…');
});

test('reasoning fragments with different item ids stay separate', () => {
  let buf = [];
  buf = appendEvent(buf, reasoning('a', 'r1'));
  buf = appendEvent(buf, reasoning('b', 'r2'));
  assert.equal(buf.length, 2);
});

test('reasoning merge does not mutate the previous buffer', () => {
  const first = appendEvent([], reasoning('a', 'r1'));
  const firstEvent = first[0];
  appendEvent(first, reasoning('b', 'r1'));
  assert.equal(firstEvent.text, 'a'); // untouched — merge produced a NEW event
});

// ── appendEvent: ux last-wins by stable id ───────────────────────────────────

test('a re-emitted ux card with the same id replaces the earlier one, at the end', () => {
  let buf = [];
  buf = appendEvent(buf, ux('draft-1'));
  buf = appendEvent(buf, reasoning('x', 'r1'));
  buf = appendEvent(buf, ux('draft-1'));
  const uxEvents = buf.filter((e) => e.kind === 'ux');
  assert.equal(uxEvents.length, 1);
  assert.equal(buf[buf.length - 1].kind, 'ux'); // last occurrence's position
});

// ── capEvents: ux surfaces are never evicted ─────────────────────────────────

test('cap evicts oldest non-ux events first and keeps order stable', () => {
  const surface = ux('pinned');
  const noise = Array.from({ length: MAX_EVENTS + 10 }, (_, i) => ({
    kind: 'delta',
    text: `d${i}`,
  }));
  const capped = capEvents([surface, ...noise]);
  assert.equal(capped.length, MAX_EVENTS);
  assert.equal(capped[0], surface); // the ux card survived at the front
  assert.equal(capped[1].text, 'd11'); // the 11 oldest deltas were evicted
});

test('a buffer of only ux surfaces may exceed the cap rather than lose cards', () => {
  const surfaces = Array.from({ length: MAX_EVENTS + 5 }, (_, i) => ux(`s${i}`));
  assert.equal(capEvents(surfaces).length, MAX_EVENTS + 5);
});

// ── open-turn tracking ───────────────────────────────────────────────────────

test('turn_completed with a matching turnId closes exactly that turn', () => {
  let open = [];
  open = reduceOpenTurns(open, started('t1'));
  open = reduceOpenTurns(open, started('t2'));
  open = reduceOpenTurns(open, completed('t1'));
  assert.deepEqual([...open], ['t2']);
});

test('an untagged turn_completed closes the OLDEST open turn (back-compat)', () => {
  let open = [];
  open = reduceOpenTurns(open, started('t1'));
  open = reduceOpenTurns(open, started('t2'));
  open = reduceOpenTurns(open, completed(undefined));
  assert.deepEqual([...open], ['t2']);
});

test('error events do NOT clear open turns — they are feed rows, not lifecycle', () => {
  let open = reduceOpenTurns([], started('t1'));
  open = reduceOpenTurns(open, { kind: 'error', message: 'render-page: hiccup' });
  assert.deepEqual([...open], ['t1']);
});

test('sandbox closed clears ALL open turns (crash escape hatch)', () => {
  let open = [];
  open = reduceOpenTurns(open, started('t1'));
  open = reduceOpenTurns(open, started('t2'));
  open = reduceOpenTurns(open, { kind: 'sandbox', status: 'closed', provider: 'local' });
  assert.equal(open.length, 0);
});

test('a completion for an unknown turn is a no-op', () => {
  const open = reduceOpenTurns(['t1'], completed('t9'));
  assert.deepEqual([...open], ['t1']);
});

test('replay recomputes busy: reload mid-turn shows working', () => {
  const log = [started('t1'), completed('t1'), started('t2'), reasoning('…', 'r')];
  assert.equal(computeOpenTurns(log).length, 1);
  const done = [...log, completed('t2')];
  assert.equal(computeOpenTurns(done).length, 0);
});
