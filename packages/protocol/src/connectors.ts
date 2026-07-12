/**
 * Connectors — every opencli site adapter surfaced as a connectable SERVICE
 * (the Manus-connector mental model): one row per site with a live login state,
 * a Connect action that opens the site's login inside Render, and automatic
 * detection when the human completes it.
 *
 * The truth source for `status` is opencli itself:
 *   `opencli <site> whoami --site-session persistent -f json` → logged_in
 * (exit 77 = disconnected; a whoami that errors past the auth gate means the
 * session is active but the adapter's verify scraper drifted — opencli runs the
 * auth check BEFORE the command, so surviving it is itself the login signal).
 *
 * Cached last-known state persists under userData so the Connectors page paints
 * instantly; probes refresh it lazily. This file is pure contract — consumed by
 * the desktop renderer today and any thin client tomorrow.
 */

/** Whether the adapter needs a logged-in session for any of its commands. */
export type ConnectorAuth = 'login' | 'none';

export type ConnectorStatus =
  /** whoami verified a live session (account may be set) */
  | 'connected'
  /** AUTH_REQUIRED / logged_in:false — sign-in needed */
  | 'disconnected'
  /** a login tab is open; Render is watching whoami for completion */
  | 'connecting'
  /** a whoami probe is in flight */
  | 'checking'
  /** never probed, or the probe was indeterminate (bridge down, timeout, no whoami) */
  | 'unknown'
  /** public adapter — no login concept at all */
  | 'none';

/** One connectable service (an opencli site adapter) as shown on the page. */
export interface ConnectorInfo {
  /** opencli site alias, e.g. "zhihu" */
  site: string;
  /** display name (the alias today; adapters carry no pretty name) */
  name: string;
  /** primary domain from adapter metadata, e.g. "zhihu.com" */
  domain?: string;
  auth: ConnectorAuth;
  status: ConnectorStatus;
  /** account label whoami reported (user_name), present when connected */
  account?: string;
  /** total commands the adapter exposes */
  commands: number;
  /** commands that require the logged-in session (cookie/browser strategy) */
  authCommands: number;
  /** ts (ms) of the last completed whoami probe */
  lastChecked?: number;
  /** human-readable qualifier: probe error, verify-drift note, logout hint… */
  detail?: string;
}
