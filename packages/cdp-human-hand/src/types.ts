/**
 * Structural types for the CDP human-hand.
 *
 * We deliberately do NOT import `electron` here: the human-hand only needs the
 * narrow surface of `webContents.debugger` (CDP 1.3) plus a couple of navigation
 * helpers. Keeping this structural means the package is decoupled, unit-testable
 * with a fake target, and the main process stays the sole owner of the real
 * tab → webContents map (it injects a resolver, per the M1 brief).
 */

/** The subset of Electron's `webContents.debugger` we drive. */
export interface CdpDebugger {
  attach(protocolVersion?: string): void;
  isAttached(): boolean;
  detach(): void;
  sendCommand(method: string, commandParams?: object, sessionId?: string): Promise<unknown>;
  on(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void,
  ): void;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): void;
  removeAllListeners(event?: string): void;
}

/** The subset of Electron's `WebContents` the human-hand touches. */
export interface CdpTarget {
  readonly id: number;
  readonly debugger: CdpDebugger;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
}

/** Dependencies the main process injects into the human-hand. */
export interface HumanHandDeps {
  /** Resolve a tabId to its live webContents (owned by the main process). */
  getTarget(tabId: string): CdpTarget | undefined;
  /** Open a new VISIBLE tab (used by `openLoginTab`); returns the new tabId. */
  createTab(url?: string): Promise<string>;
  /** All currently-attachable tabs, for CDP discovery on the relay. */
  listTabs(): Array<{ tabId: string; url: string; title: string }>;
  /** Relay bind host (default 127.0.0.1). */
  relayHost?: string;
  /** Relay bind port (default 0 = ephemeral, or OPENCLI_CDP_PORT). */
  relayPort?: number;
}

/** A CDP command arriving from a remote relay client. */
export interface RelayCommand {
  id: number | string;
  method: string;
  params?: object;
  /** which tab to target; defaults to the relay's active tab */
  tabId?: string;
}

export interface RelayTarget {
  tabId: string;
  url: string;
  title: string;
}
