/**
 * Chrome layout geometry — the single source of truth for where the native page
 * `WebContentsView`s sit relative to the (untrusted) chrome renderer.
 *
 * Native views always paint ABOVE the HTML renderer, so the page view is INSET
 * to leave the chrome's regions uncovered: a top bar (tab strip + omnibox), a
 * right agent panel, and a bottom band for the always-visible floating input.
 * These numbers MUST match the renderer CSS (see styles.css :root vars).
 */

export const CHROME = {
  topBar: 84, // tab strip + omnibox
  panelWidth: 460, // right-side agent panel — DEFAULT; user-resizable at runtime
  panelMin: 300,
  panelMax: 820,
  bottomBand: 76, // floating input band (never covered by a page)
} as const;

export function clampPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return CHROME.panelWidth;
  return Math.max(CHROME.panelMin, Math.min(CHROME.panelMax, Math.round(w)));
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rect a web page occupies inside the content area, given window size. */
export function contentBounds(
  winWidth: number,
  winHeight: number,
  panelOpen: boolean,
  panelWidth: number = CHROME.panelWidth,
): Bounds {
  const right = panelOpen ? panelWidth : 0;
  return {
    x: 0,
    y: CHROME.topBar,
    width: Math.max(0, winWidth - right),
    height: Math.max(0, winHeight - CHROME.topBar - CHROME.bottomBand),
  };
}
