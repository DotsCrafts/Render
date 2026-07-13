// layout — the chrome geometry contract behind the native page-view insets.
// Pins the summonable-input-layer behavior: the bottom inset follows the
// input's visibility (full band open, slim recall handle dismissed), and the
// renderer CSS vars (--top-bar/--bottom-band/--handle-band) must keep matching
// these numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHROME, clampPanelWidth, contentBounds } from '../src/main/layout.ts';

test('input open (default) insets the full bottom band', () => {
  const b = contentBounds(1440, 920, true);
  assert.deepEqual(b, {
    x: 0,
    y: CHROME.topBar,
    width: 1440 - CHROME.panelWidth,
    height: 920 - CHROME.topBar - CHROME.bottomBand,
  });
});

test('input dismissed leaves only the recall-handle strip uncovered', () => {
  const open = contentBounds(1440, 920, true, CHROME.panelWidth, true);
  const dismissed = contentBounds(1440, 920, true, CHROME.panelWidth, false);
  assert.equal(dismissed.height - open.height, CHROME.bottomBand - CHROME.handleBand);
  assert.equal(dismissed.height, 920 - CHROME.topBar - CHROME.handleBand);
  // x/y/width are input-state independent
  assert.deepEqual([dismissed.x, dismissed.y, dismissed.width], [open.x, open.y, open.width]);
});

test('panel closed hands the full width to the page in both input states', () => {
  for (const inputOpen of [true, false]) {
    const b = contentBounds(1440, 920, false, CHROME.panelWidth, inputOpen);
    assert.equal(b.width, 1440);
  }
});

test('degenerate window sizes clamp to zero, never negative', () => {
  const b = contentBounds(200, 60, true, CHROME.panelWidth, false);
  assert.equal(b.height, 0);
  const c = contentBounds(0, 0, true);
  assert.deepEqual([c.width, c.height], [0, 0]);
});

test('clampPanelWidth bounds and sanitizes', () => {
  assert.equal(clampPanelWidth(CHROME.panelMin - 100), CHROME.panelMin);
  assert.equal(clampPanelWidth(CHROME.panelMax + 100), CHROME.panelMax);
  assert.equal(clampPanelWidth(512.4), 512);
  assert.equal(clampPanelWidth(Number.NaN), CHROME.panelWidth);
});
