import { useState, type ReactElement } from 'react';
import { useRenderState } from './useRenderState.js';
import { TabStrip } from './components/TabStrip.js';
import { Omnibox } from './components/Omnibox.js';
import { FloatingInput } from './components/FloatingInput.js';
import { AgentPanel } from './components/AgentPanel.js';
import { CodexSettings } from './components/CodexSettings.js';

/**
 * The browser chrome (untrusted display). The real web pages are native
 * WebContentsViews painted by the main process into the `.stage` region; this
 * React tree only draws the surrounding chrome and talks to main over IPC.
 */
export function App(): ReactElement {
  const { tabs, activeTab, events, busy, actions } = useRenderState();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="app">
      <header className="topbar">
        <TabStrip
          tabs={tabs}
          activeId={activeTab?.id}
          onActivate={actions.activateTab}
          onClose={actions.closeTab}
          onNew={actions.newTab}
        />
        <Omnibox
          activeTab={activeTab}
          onNavigate={actions.navigate}
          onBack={actions.back}
          onForward={actions.forward}
          onReload={actions.reload}
        />
        <button
          className="settings-btn"
          onClick={() => setShowSettings(true)}
          aria-label="codex settings"
          title="Codex 设置"
        >
          ⚙
        </button>
      </header>

      {showSettings ? <CodexSettings onClose={() => setShowSettings(false)} /> : null}

      <main className="stage">
        <div className="hint">{tabs.length === 0 ? 'opening tab…' : ''}</div>
      </main>

      <AgentPanel events={events} onResolve={actions.resolveUx} />

      <div className="inputband">
        <FloatingInput busy={busy} onSubmit={actions.submit} onCancel={actions.cancel} />
      </div>
    </div>
  );
}
