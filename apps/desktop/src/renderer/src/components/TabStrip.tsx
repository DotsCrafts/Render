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
      {tab.loading ? (
        <span className="spinner" aria-hidden />
      ) : (
        <span className="favicon" aria-hidden />
      )}
      <span className="title">{tab.title || 'New Tab'}</span>
      <button
        className="close"
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        aria-label="close tab"
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M1 1l8 8M9 1l-8 8" />
        </svg>
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
            <span className="tab-group-label">
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                <path d="M7 1.5l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 9.7 3.8 11.4l.6-3.6L1.8 5.3l3.6-.5z" />
              </svg>
              {seg.label}
            </span>
            {seg.tabs.map(renderTab)}
          </div>
        ) : (
          seg.tabs.map(renderTab)
        ),
      )}
      <button className="tab-new" onClick={onNew} aria-label="new tab" title="New tab">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M7 2v10M2 7h10" />
        </svg>
      </button>
      <button
        className="tab-new-conversation"
        onClick={onNewConversation}
        aria-label="new conversation"
        title="New conversation (new agent tab group)"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M7 1.5l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 9.7 3.8 11.4l.6-3.6L1.8 5.3l3.6-.5z" />
        </svg>
      </button>
    </div>
  );
}
