import { useEffect, useState, type ReactElement } from 'react';
import type { TabState } from '@render/protocol';

interface Props {
  activeTab: TabState | undefined;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

/** Is this an https/secure origin? Used for the omnibox security affordance. */
function isSecure(url: string | undefined): boolean {
  return !!url && /^https:\/\//i.test(url);
}

export function Omnibox({
  activeTab,
  onNavigate,
  onBack,
  onForward,
  onReload,
  panelOpen,
  onTogglePanel,
}: Props): ReactElement {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);

  // keep the box in sync with the active tab's URL unless the user is typing
  useEffect(() => {
    if (!editing) setValue(activeTab?.url ?? '');
  }, [activeTab?.url, editing]);

  const secure = isSecure(activeTab?.url);
  const loading = !!activeTab?.loading;

  return (
    <form
      className="omnibox"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onNavigate(value.trim());
        (document.activeElement as HTMLElement | null)?.blur();
        setEditing(false);
      }}
    >
      <div className="nav">
        <button type="button" title="Back" aria-label="back" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3l-5 5 5 5" />
          </svg>
        </button>
        <button type="button" title="Forward" aria-label="forward" onClick={onForward}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>
        <button type="button" title="Reload" aria-label="reload" onClick={onReload}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 2v3h-3" />
          </svg>
        </button>
      </div>

      <div className={`field${editing ? ' focused' : ''}`}>
        <span className={`secure${secure ? '' : ' insecure'}`} aria-hidden title={secure ? 'Secure' : 'Not secure'}>
          {secure ? (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2.5" y="6" width="9" height="6" rx="1.2" />
              <path d="M4.5 6V4.2a2.5 2.5 0 015 0V6" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="7" cy="7" r="5.3" />
              <path d="M1.7 7h10.6M7 1.7c1.6 1.6 1.6 9 0 10.6M7 1.7c-1.6 1.6-1.6 9 0 10.6" />
            </svg>
          )}
        </span>
        <input
          value={value}
          spellCheck={false}
          placeholder="Search or enter address"
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setValue(e.target.value)}
        />
        {loading ? <span className="loadbar" aria-hidden /> : null}
      </div>

      <div className="nav">
        <button
          type="button"
          className={`toggle-panel${panelOpen ? ' on' : ''}`}
          title={panelOpen ? 'Hide agent panel' : 'Show agent panel'}
          aria-label="toggle agent panel"
          aria-pressed={panelOpen}
          onClick={onTogglePanel}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M10 2.5v11" />
          </svg>
        </button>
      </div>
    </form>
  );
}
