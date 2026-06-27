import { useEffect, useState, type ReactElement } from 'react';
import type { SavedPageMeta } from '@render/protocol';

interface Props {
  onClose: () => void;
  onOpen: (id: string) => Promise<boolean>;
  onAsk: (id: string, instruction: string) => void;
  list: () => Promise<SavedPageMeta[]>;
}

/**
 * Delta 3 — the Saved-Pages launcher: a grid of reusable mini-apps. Each card
 * re-serves its saved spec into a tab (live data refetched) or pulls the page
 * back into the conversation for a new version (Delta 5). Rendered as a modal
 * over the chrome (native page views are hidden by App while it's open).
 */
export function SavedPagesGallery({ onClose, onOpen, onAsk, list }: Props): ReactElement {
  const [pages, setPages] = useState<SavedPageMeta[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void list().then((p) => {
      if (live) setPages(p);
    });
    return () => {
      live = false;
    };
  }, [list]);

  const open = async (id: string): Promise<void> => {
    setOpening(id);
    try {
      await onOpen(id);
      onClose();
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="gallery-scrim" onClick={onClose} role="presentation">
      <div
        className="gallery"
        role="dialog"
        aria-label="Saved pages"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gallery-head">
          <h2>Saved pages</h2>
          <button className="gallery-close" onClick={onClose} aria-label="close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        {pages === null ? (
          <div className="gallery-state">Loading…</div>
        ) : pages.length === 0 ? (
          <div className="gallery-state">
            <p>No saved pages yet.</p>
            <p className="gallery-hint">
              When the agent opens an interactive page, use <strong>Save</strong> on
              its card to keep it here as a reusable mini-app.
            </p>
          </div>
        ) : (
          <div className="gallery-grid">
            {pages.map((p) => (
              <div key={p.id} className="gallery-card">
                <div className="gallery-card-body">
                  <div className="gallery-card-title">{p.title}</div>
                  <div className="gallery-card-meta">
                    v{p.version} · saved {timeAgo(p.savedAt)}
                  </div>
                  {p.allow ? (
                    <div className="gallery-card-allow" title={p.allow}>
                      {p.allow}
                    </div>
                  ) : null}
                </div>
                <div className="gallery-card-actions">
                  <button
                    className="gallery-btn primary"
                    onClick={() => void open(p.id)}
                    disabled={opening === p.id}
                  >
                    {opening === p.id ? 'Opening…' : 'Open'}
                  </button>
                  <button
                    className="gallery-btn"
                    onClick={() => {
                      onAsk(p.id, '');
                      onClose();
                    }}
                    title="Pull this page back into the conversation for a new version"
                  >
                    Ask agent
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
