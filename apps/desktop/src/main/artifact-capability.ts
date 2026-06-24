/**
 * Artifact capability gate (main-process, trusted).
 *
 * Owns, per session:
 *   • the registry of live artifacts → their declared opencli allowlist
 *   • the per-artifact consent grant (granted once, cached for the session)
 *   • the consent round-trip: surface a kind:'ux' CONFIRM in the agent panel and
 *     block the artifact's opencli call until the human resolves it.
 *
 * This is the policy core that stops a prompt-injected agent from silently
 * exfiltrating the user's logged-in data: even though the artifact is already
 * network-isolated (ephemeral partition + no-network CSP), its ONLY backdoor —
 * the opencli capability — is allowlisted (the agent had to DECLARE the sites at
 * generate time) AND consented (the human had to approve them) AND read-only.
 */

import type { Artifact, UxMessage, UxResult, UxConfirmResult } from '@render/protocol';

export interface ArtifactCapabilityDeps {
  /** push a ux confirm card into the agent panel */
  emit: (message: UxMessage) => void;
  now: () => number;
  /** mint a unique ux id (shares the runtime's counter for stable ordering) */
  nextUxId: () => string;
}

export interface ArtifactCapability {
  /** record an artifact's declared allowlist so later opencli calls can be checked */
  register(artifact: Artifact): void;
  /** drop an artifact (tab closed / conversation ended) — revokes its grant */
  forget(id: string): void;
  forgetAll(): void;
  /**
   * Authorize an `<site> <command>` read for an artifact: enforce the allowlist,
   * then (once per artifact) require human consent via a ux confirm. Resolves
   * with whether the call may proceed.
   */
  authorize(id: string, site: string, command: string): Promise<{ ok: boolean; error?: string }>;
  /** route a resolved confirm back here; returns true if it was an artifact consent */
  resolveConsent(uxId: string, result: UxResult): boolean;
}

interface PendingConsent {
  artifactId: string;
  resolve: (granted: boolean) => void;
}

export function createArtifactCapability(deps: ArtifactCapabilityDeps): ArtifactCapability {
  // artifact id → its declared allowlist as a Set of "<site> <command>".
  const allowlists = new Map<string, Set<string>>();
  // artifact id → consent state: 'granted' once approved; absent = never asked.
  const granted = new Set<string>();
  // artifact id → an in-flight consent prompt promise, so concurrent calls from
  // the same page coalesce onto ONE confirm card.
  const inflight = new Map<string, Promise<boolean>>();
  // ux confirm id → the pending consent it resolves.
  const pending = new Map<string, PendingConsent>();

  const register = (artifact: Artifact): void => {
    allowlists.set(artifact.id, new Set((artifact.opencli ?? []).map(normalize)));
  };

  const forget = (id: string): void => {
    allowlists.delete(id);
    granted.delete(id);
    inflight.delete(id);
    for (const [uxId, p] of pending) {
      if (p.artifactId === id) {
        p.resolve(false);
        pending.delete(uxId);
      }
    }
  };

  const forgetAll = (): void => {
    for (const id of [...allowlists.keys()]) forget(id);
  };

  const authorize = async (
    id: string,
    site: string,
    command: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const allow = allowlists.get(id);
    if (!allow) return { ok: false, error: 'unknown artifact' };
    const key = normalize(`${site} ${command}`);
    if (!allow.has(key)) {
      return { ok: false, error: `"${site} ${command}" is not in this app's declared opencli allowlist` };
    }
    if (granted.has(id)) return { ok: true };
    const ok = await requestConsent(id);
    return ok ? { ok: true } : { ok: false, error: 'the user declined to allow this app to query those sites' };
  };

  const requestConsent = (id: string): Promise<boolean> => {
    const existing = inflight.get(id);
    if (existing) return existing;
    const sites = sitesFor(id);
    const promise = new Promise<boolean>((resolve) => {
      const uxId = deps.nextUxId();
      pending.set(uxId, { artifactId: id, resolve });
      deps.emit(consentCard(uxId, sites, deps.now()));
    }).then((ok) => {
      inflight.delete(id);
      if (ok) granted.add(id);
      return ok;
    });
    inflight.set(id, promise);
    return promise;
  };

  const sitesFor = (id: string): string[] => {
    const allow = allowlists.get(id);
    if (!allow) return [];
    return [...new Set([...allow].map((k) => k.split(' ')[0]))];
  };

  const resolveConsent = (uxId: string, result: UxResult): boolean => {
    const p = pending.get(uxId);
    if (!p) return false;
    pending.delete(uxId);
    const confirm = result as UxConfirmResult;
    const ok = confirm.action === 'ux_confirm' && confirm.choice !== '拒绝' && confirm.choice !== 'Deny';
    p.resolve(ok);
    return true;
  };

  return { register, forget, forgetAll, authorize, resolveConsent };
}

/** Collapse whitespace + lowercase a "<site> <command>" key for stable matching. */
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function consentCard(uxId: string, sites: string[], ts: number): UxMessage {
  const list = sites.length ? sites.join(', ') : 'a backend';
  return {
    id: uxId,
    kind: 'confirm',
    blocking: false, // the artifact awaits it, but the agent turn isn't frozen
    ts,
    spec: {
      message: `This page wants to query: ${list}. Allow it to read from these on your behalf?`,
      options: ['允许', '拒绝'],
      danger: false,
      detail:
        'The app runs isolated (no direct network, no access to your logins). Allowing lets it run READ-ONLY opencli queries against the sites above, using your Render session. Allowed once per app for this session.',
    },
  };
}
