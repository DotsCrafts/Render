import type { TabState } from '@render/protocol';

interface Props {
  tabs: TabState[];
  activeId: string | undefined;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function TabStrip({ tabs, activeId, onActivate, onClose, onNew }: Props): JSX.Element {
  return (
    <div className="tabstrip">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab${tab.id === activeId ? ' active' : ''}`}
          onClick={() => onActivate(tab.id)}
          title={tab.url}
        >
          {tab.loading ? <span className="spinner" /> : null}
          <span className="title">{tab.title || 'New Tab'}</span>
          <button
            className="close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            aria-label="close tab"
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={onNew} aria-label="new tab">
        +
      </button>
    </div>
  );
}
