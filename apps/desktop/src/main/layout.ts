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
  panelWidth: 360, // right-side agent event-stream panel
  bottomBand: 76, // floating input band (never covered by a page)
} as const;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rect a web page occupies inside the content area, given window size. */
export function contentBounds(winWidth: number, winHeight: number, panelOpen: boolean): Bounds {
  const right = panelOpen ? CHROME.panelWidth : 0;
  return {
    x: 0,
    y: CHROME.topBar,
    width: Math.max(0, winWidth - right),
    height: Math.max(0, winHeight - CHROME.topBar - CHROME.bottomBand),
  };
}
