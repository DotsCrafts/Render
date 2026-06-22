import { useEffect, useState, type ReactElement } from 'react';
import type { TabState } from '@render/protocol';

interface Props {
  activeTab: TabState | undefined;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
}

export function Omnibox({ activeTab, onNavigate, onBack, onForward, onReload }: Props): ReactElement {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);

  // keep the box in sync with the active tab's URL unless the user is typing
  useEffect(() => {
    if (!editing) setValue(activeTab?.url ?? '');
  }, [activeTab?.url, editing]);

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
      <button type="button" title="back" onClick={onBack}>
        ‹
      </button>
      <button type="button" title="forward" onClick={onForward}>
        ›
      </button>
      <button type="button" title="reload" onClick={onReload}>
        ⟳
      </button>
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
    </form>
  );
}
