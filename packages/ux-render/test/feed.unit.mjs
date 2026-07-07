/**
 * Unit tests for groupEvents — the pure fold from AgentEvent[] to feed blocks.
 *
 * Guards the fixes for:
 *  - reasoning-fragments-as-steps: fragments merge into one readable step and
 *    the completed reasoning item REPLACES the accumulation (no duplicate);
 *  - no-mid-turn-streaming: started commands render as in-progress steps
 *    upgraded IN PLACE on completion, shim commands never leak, and ux
 *    surfaces dedupe last-wins by message id.
 *
 * Run: node test/run.mjs (bundles this suite so the .tsx import works).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupEvents } from '../src/EventFeed.tsx';

const reasoning = (text, itemId) => ({
  kind: 'reasoning',
  text,
  ...(itemId ? { itemId } : {}),
});
const item = (phase, it) => ({ kind: 'item', phase, item: it });
const ux = (id, body = id) => ({
  kind: 'ux',
  message: { id, kind: 'render', blocking: false, spec: { body }, ts: 0 },
});

const lanes = (blocks) => blocks.filter((b) => b.type === 'activity');
const steps = (blocks) => lanes(blocks).flatMap((l) => l.steps);

// ── reasoning coalescing ─────────────────────────────────────────────────────

test('consecutive reasoning fragments merge into one step', () => {
  const blocks = groupEvents([
    reasoning('planning ', 'r1'),
    reasoning('the ', 'r1'),
    reasoning('route', 'r1'),
  ]);
  const s = steps(blocks);
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, 'reason');
  assert.equal(s[0].text, 'planning the route');
});

test('fragments merge even when itemId is absent', () => {
  const s = steps(groupEvents([reasoning('a'), reasoning('b')]));
  assert.equal(s.length, 1);
  assert.equal(s[0].text, 'ab');
});

test('different reasoning items stay separate steps', () => {
  const s = steps(groupEvents([reasoning('a', 'r1'), reasoning('b', 'r2')]));
  assert.equal(s.length, 2);
});

test('the completed reasoning item REPLACES the accumulated fragments', () => {
  const s = steps(
    groupEvents([
      reasoning('plann', 'r1'),
      reasoning('ing', 'r1'),
      item('completed', { id: 'r1', type: 'reasoning', text: 'planning the full route' }),
    ]),
  );
  assert.equal(s.length, 1);
  assert.equal(s[0].text, 'planning the full route');
});

test('a completed reasoning item with no prior fragments becomes one step', () => {
  const s = steps(
    groupEvents([item('completed', { id: 'r1', type: 'reasoning', text: 'thought' })]),
  );
  assert.equal(s.length, 1);
  assert.equal(s[0].text, 'thought');
});

// ── mid-turn command streaming ───────────────────────────────────────────────

test('a started command renders one pending step, upgraded in place on completion', () => {
  const startedOnly = steps(
    groupEvents([item('started', { id: 'c1', type: 'commandExecution', command: 'opencli xhs search' })]),
  );
  assert.equal(startedOnly.length, 1);
  assert.equal(startedOnly[0].pending, true);
  assert.equal(startedOnly[0].text, 'opencli xhs search');

  const both = steps(
    groupEvents([
      item('started', { id: 'c1', type: 'commandExecution', command: 'opencli xhs search' }),
      item('completed', { id: 'c1', type: 'commandExecution', command: 'opencli xhs search', exitCode: 0 }),
    ]),
  );
  assert.equal(both.length, 1); // no duplicate rows
  assert.equal(both[0].pending, false);
  assert.equal(both[0].text, 'opencli xhs search → exit 0');
});

test('the in-place upgrade reaches back across a lane break', () => {
  const blocks = groupEvents([
    item('started', { id: 'c1', type: 'commandExecution', command: 'sleep 5' }),
    ux('mid'),
    item('completed', { id: 'c1', type: 'commandExecution', command: 'sleep 5', exitCode: 0 }),
  ]);
  const s = steps(blocks);
  assert.equal(s.length, 1);
  assert.equal(s[0].text, 'sleep 5 → exit 0');
  assert.equal(s[0].pending, false);
});

test('render-open / render-page shim commands never leak at the started phase', () => {
  const s = steps(
    groupEvents([
      item('started', { id: 's1', type: 'commandExecution', command: 'render-open https://x.com' }),
      item('started', { id: 's2', type: 'commandExecution', command: "zsh -lc 'render-page /tmp/spec.json --title T'" }),
      item('started', { id: 's3', type: 'commandExecution', command: 'echo not-a-shim' }),
    ]),
  );
  assert.equal(s.length, 1);
  assert.equal(s[0].text, 'echo not-a-shim');
});

test('a completed command with no started twin still renders once', () => {
  const s = steps(
    groupEvents([item('completed', { id: 'c9', type: 'commandExecution', command: 'ls', exitCode: 0 })]),
  );
  assert.equal(s.length, 1);
  assert.equal(s[0].text, 'ls → exit 0');
});

// ── ux surface dedupe (last-wins) ────────────────────────────────────────────

test('re-emitted ux cards dedupe by message id, keeping the LAST position', () => {
  const events = [ux('draft'), reasoning('working', 'r1'), ux('draft'), ux('other')];
  const blocks = groupEvents(events);
  const surfaces = blocks.filter((b) => b.type === 'surface');
  assert.equal(surfaces.length, 2);
  assert.equal(surfaces[0].key, 'draft');
  assert.equal(surfaces[0].index, 2); // the LAST emission's event index
  const pos = blocks.findIndex((b) => b.type === 'surface' && b.key === 'draft');
  const lanePos = blocks.findIndex((b) => b.type === 'activity');
  assert.ok(pos > lanePos, 'the surviving draft renders after the activity lane');
});

test('delta events remain pure liveness noise (no blocks)', () => {
  assert.equal(groupEvents([{ kind: 'delta', text: 'tok' }]).length, 0);
});
