/**
 * Browser-chrome navigation channels (back / forward / reload).
 *
 * These are intentionally SEPARATE from the protocol `RenderApi`: that contract
 * is the agent-facing surface and is kept verbatim so the real bridge is
 * drop-in. History navigation is pure browser-chrome plumbing, exposed to the
 * renderer as `window.renderChrome` rather than polluting `RenderApi`.
 */

export const CHROME_IPC = {
  back: 'render:chrome:back',
  forward: 'render:chrome:forward',
  reload: 'render:chrome:reload',
} as const;

export interface RenderChromeApi {
  back(tabId: string): Promise<void>;
  forward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
}
