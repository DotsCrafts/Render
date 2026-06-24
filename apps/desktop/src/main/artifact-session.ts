/**
 * Isolation primitives for a Tier-2 artifact tab.
 *
 * An artifact gets its OWN ephemeral session (partition `artifact:<id>`, NO
 * `persist:` prefix → in-memory, wiped when the partition's last view dies). It
 * is NEVER the shared `persist:render` session that holds the user's logins, so
 * agent-generated code can't touch the user's cookies. On top of that we inject a
 * locked-down CSP via `onHeadersReceived`: inline styles/scripts + data: URIs are
 * allowed (the artifact is one self-contained file), but `connect-src 'self'`
 * denies arbitrary network — the page's ONLY backend path is the consented
 * `window.renderArtifact.opencli` capability bridge.
 */

import { session, type Session } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Ephemeral (in-memory) partition name for an artifact id. NOT `persist:`. */
export function artifactPartition(id: string): string {
  return `artifact:${id}`;
}

const CSP = "default-src 'self' 'unsafe-inline' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";

/**
 * Configure the artifact's isolated session: inject the no-network CSP on every
 * response so even a page that tries to fetch/XHR out is blocked. Idempotent per
 * session (Electron replaces the handler on each call).
 */
export function hardenArtifactSession(partition: string): Session {
  const sess = session.fromPartition(partition);
  sess.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    // strip any upstream CSP so ours is authoritative, then set the lockdown.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [CSP];
    callback({ responseHeaders: headers });
  });
  return sess;
}

/**
 * Write the artifact's HTML to a temp file and return a `file://` URL. We load
 * from a file (not a data: URL) so the page has a stable `'self'` origin the CSP
 * `connect-src 'self'` can key on and so the preload attaches cleanly. The temp
 * dir is ephemeral; callers needn't clean it (OS temp), matching 阅后即焚.
 */
export function writeArtifactFile(id: string, html: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'render-artifact-'));
  const file = join(dir, `${safeName(id)}.html`);
  writeFileSync(file, html, 'utf8');
  return `file://${file}`;
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'artifact';
}
