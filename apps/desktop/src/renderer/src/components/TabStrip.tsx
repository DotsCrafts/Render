import type { ReactElement } from 'react';
import type { TabState } from '@render/protocol';

interface Props {
  tabs: TabState[];
  activeId: string | undefined;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Start a fresh agent conversation — new codex thread + new tab group. */
  onNewConversation: () => void;
}

/** A run of consecutive tabs — either loose (no group) or one tab group. */
interface Segment {
  groupId?: string;
  label?: string;
  color?: string;
  tabs: TabState[];
}

/** Collapse the flat tab list into runs of consecutive same-group tabs. */
function toSegments(tabs: TabState[]): Segment[] {
  const segments: Segment[] = [];
  for (const tab of tabs) {
    const gid = tab.group?.id;
    const last = segments[segments.length - 1];
    if (last && last.groupId === gid) {
      last.tabs.push(tab);
    } else {
      segments.push({
        groupId: gid,
        label: tab.group?.label,
        color: tab.group?.color,
        tabs: [tab],
      });
    }
  }
  return segments;
}

export function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
  onNewConversation,
}: Props): ReactElement {
  const renderTab = (tab: TabState): ReactElement => (
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
  );

  return (
    <div className="tabstrip">
      {toSegments(tabs).map((seg, i) =>
        seg.groupId ? (
          <div
            key={`g-${seg.groupId}-${i}`}
            className="tab-group"
            style={{ ['--group-color' as string]: seg.color }}
            title={seg.label}
          >
            <span className="tab-group-label">{seg.label}</span>
            {seg.tabs.map(renderTab)}
          </div>
        ) : (
          seg.tabs.map(renderTab)
        ),
      )}
      <button className="tab-new" onClick={onNew} aria-label="new tab">
        +
      </button>
      <button
        className="tab-new-conversation"
        onClick={onNewConversation}
        aria-label="new conversation"
        title="New conversation (new agent tab group)"
      >
        ⊕
      </button>
    </div>
  );
}
