import type { RenderApi } from '@render/protocol';
import type { RenderChromeApi } from '../shared/chrome-channels.js';

declare global {
  interface Window {
    /** the contextBridge-exposed protocol surface (see preload/index.ts) */
    render: RenderApi;
    /** browser-chrome history navigation (separate from the agent RenderApi) */
    renderChrome: RenderChromeApi;
  }
}

export {};
