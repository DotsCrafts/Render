import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ConnectorInfo } from '@render/protocol';

interface Props {
  onClose: () => void;
}

/**
 * Connectors — every opencli site adapter as a connectable service (the
 * Manus-connector mental model). One card per login site with a LIVE status:
 * Connect opens the site's sign-in inside Render and the row flips to
 * Connected by itself when the whoami watch sees the session land. Public
 * (no-login) adapters are listed compactly below so the catalog stays visible.
 *
 * Rendered as a modal over the chrome (native page views are hidden by App
 * while it's open). All state streams from main over connectorsChanged; the
 * buttons only kick main-process transitions and never assert an outcome.
 */
export function Connectors({ onClose }: Props): ReactElement {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let live = true;
    const off = window.render.onConnectorsChanged((list) => {
      if (live) setConnectors(list);
    });
    // paint from cache instantly, then probe whatever's stale
    window.render
      .connectorsList()
      .then((list) => {
        if (!live) return undefined;
        setConnectors(list);
        setRefreshing(true);
        return window.render.connectorsRefresh();
      })
      .then((list) => {
        if (live && list) setConnectors(list);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setRefreshing(false);
      });
    return () => {
      live = false;
      off();
    };
  }, []);

  const loginSites = useMemo(
    () => (connectors ?? []).filter((c) => c.auth === 'login'),
    [connectors],
  );
  const publicSites = useMemo(
    () => (connectors ?? []).filter((c) => c.auth === 'none'),
    [connectors],
  );

  const refreshAll = (): void => {
    setRefreshing(true);
    window.render
      .connectorsRefresh()
      .then(setConnectors)
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="gallery-scrim" onClick={onClose} role="presentation">
      <div
        className="gallery connectors"
        role="dialog"
        aria-label="Connectors"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gallery-head">
          <div>
            <h2>Connectors</h2>
            <p className="connectors-sub">
              Sites the agent can act on. Sign in once — the session stays inside Render and
              every opencli command reuses it.
            </p>
          </div>
          <div className="connectors-head-actions">
            <button
              className="gallery-btn"
              onClick={refreshAll}
              disabled={refreshing}
              title="Re-probe login sites not checked in the last few minutes"
            >
              {refreshing ? 'Checking…' : 'Refresh'}
            </button>
            <button className="gallery-close" onClick={onClose} aria-label="close">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </header>

        {connectors === null ? (
          <div className="gallery-state">{error ?? 'Loading connectors…'}</div>
        ) : loginSites.length === 0 && publicSites.length === 0 ? (
          <div className="gallery-state">
            <p>{error ?? 'No opencli adapters found.'}</p>
            <p className="gallery-hint">
              Is the opencli engine running? Try <strong>opencli doctor</strong> in a terminal,
              then reopen this panel.
            </p>
          </div>
        ) : (
          <div className="connectors-body">
            <div className="connectors-grid">
              {loginSites.map((c) => (
                <ConnectorCard key={c.site} c={c} />
              ))}
            </div>
            {publicSites.length > 0 ? (
              <div className="connectors-public">
                <div className="connectors-public-title">
                  No sign-in needed · {publicSites.length}
                </div>
                <div className="connectors-public-chips">
                  {publicSites.map((c) => (
                    <span key={c.site} className="connectors-chip" title={c.domain ?? c.site}>
                      <Avatar c={c} size={14} />
                      {c.site}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectorCard({ c }: { c: ConnectorInfo }): ReactElement {
  const busy = c.status === 'checking' || c.status === 'connecting';
  const connect = (): void => void window.render.connectorsConnect(c.site).catch(() => {});
  const check = (): void => void window.render.connectorsRefresh(c.site).catch(() => {});
  const disconnect = (): void => void window.render.connectorsDisconnect(c.site).catch(() => {});

  return (
    <div className={`connector-card status-${c.status}`}>
      <div className="connector-row">
        <Avatar c={c} size={28} />
        <div className="connector-id">
          <div className="connector-name">
            {c.name}
            <StatusBadge c={c} />
          </div>
          <div className="connector-meta">
            {c.status === 'connected' && c.account ? (
              <span className="connector-account" title={c.account}>
                {c.account}
              </span>
            ) : (
              (c.domain ?? `${c.authCommands} login command${c.authCommands === 1 ? '' : 's'}`)
            )}
          </div>
        </div>
      </div>

      {c.detail ? (
        <div className="connector-detail" title={c.detail}>
          {c.detail}
        </div>
      ) : null}

      <div className="connector-actions">
        {c.status === 'connected' ? (
          <button className="gallery-btn" onClick={disconnect} disabled={busy}>
            Disconnect
          </button>
        ) : (
          <button className="gallery-btn primary" onClick={connect} disabled={busy}>
            {c.status === 'connecting' ? 'Waiting for sign-in…' : 'Connect'}
          </button>
        )}
        <button
          className="gallery-btn"
          onClick={check}
          disabled={c.status === 'checking'}
          title={c.lastChecked ? `Last checked ${timeAgo(c.lastChecked)}` : 'Never checked'}
        >
          {c.status === 'checking' ? 'Checking…' : 'Check'}
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ c }: { c: ConnectorInfo }): ReactElement | null {
  switch (c.status) {
    case 'connected':
      return <span className="connector-badge ok">Connected</span>;
    case 'connecting':
      return <span className="connector-badge live">Waiting for sign-in</span>;
    case 'checking':
      return <span className="connector-badge live">Checking</span>;
    case 'disconnected':
      return <span className="connector-badge off">Not connected</span>;
    case 'unknown':
      return <span className="connector-badge dim">Unknown</span>;
    default:
      return null;
  }
}

/** Site favicon (first-party fetch only) with a letter-avatar fallback. */
function Avatar({ c, size }: { c: ConnectorInfo; size: number }): ReactElement {
  const [failed, setFailed] = useState(false);
  if (!c.domain || failed) {
    return (
      <span className="connector-avatar letter" style={{ width: size, height: size }} aria-hidden>
        {c.site.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="connector-avatar"
      style={{ width: size, height: size }}
      src={`https://${c.domain}/favicon.ico`}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
