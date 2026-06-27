import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { UxMessage } from '@render/protocol';
import type { ResultAction } from '@render/ux-render';
import { useRenderState } from './useRenderState.js';
import { TabStrip } from './components/TabStrip.js';
import { Omnibox } from './components/Omnibox.js';
import { FloatingInput } from './components/FloatingInput.js';
import { AgentPanel } from './components/AgentPanel.js';
import { CodexSettings } from './components/CodexSettings.js';
import { SavedPagesGallery } from './components/SavedPagesGallery.js';
import { Home } from './components/Home.js';

/**
 * The browser chrome (untrusted display). The real web pages are native
 * WebContentsViews painted by the main process into the `.stage` region; this
 * React tree only draws the surrounding chrome and talks to main over IPC.
 */
export function App(): ReactElement {
  const { tabs, activeTab, events, busy, actions } = useRenderState();
  const [showSettings, setShowSettings] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  // Delta 2: a seeded prefill for the floating input (Refine / Ask follow-up).
  const [seed, setSeed] = useState<{ text: string; nonce: number }>({ text: '', nonce: 0 });
  // Delta 3: pages saved this session — marks their card's Save button done.
  const [savedPageIds, setSavedPageIds] = useState<Set<string>>(() => new Set());

  // Native page views composite over the chrome renderer, so they'd occlude any
  // renderer modal (settings / saved-pages gallery). Hide them while one is open.
  useEffect(() => {
    void window.render.setOverlay(showSettings || showGallery);
  }, [showSettings, showGallery]);

  // Delta 2: route a result card's next-step action. Refine/Ask-follow-up seed the
  // floating input; Save persists the page; Open-as-page asks the agent to build
  // one; Ask-agent pulls a saved page back into the conversation (Delta 5).
  const onResultAction = useCallback(
    (action: ResultAction, message: UxMessage) => {
      switch (action) {
        case 'refine':
          setSeed((s) => ({ text: 'Refine the previous result: ', nonce: s.nonce + 1 }));
          break;
        case 'follow_up':
          setSeed((s) => ({ text: '', nonce: s.nonce + 1 }));
          break;
        case 'open_page':
          actions.submit(
            'Turn the previous result into an interactive page (use render-page).',
          );
          break;
        case 'save':
          if (message.page) {
            const id = message.page.id;
            void actions.savePage(id).then(() =>
              setSavedPageIds((prev) => {
                const next = new Set(prev);
                next.add(id);
                return next;
              }),
            );
          }
          break;
        case 'ask_agent':
          if (message.page) actions.askPage(message.page.id, '');
          break;
      }
    },
    [actions],
  );

  // Collapse/expand the agent panel — re-insets the native page views to match.
  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      const next = !open;
      void window.render.setPanelOpen(next);
      return next;
    });
  }, []);

  return (
    <div className={`app${panelOpen ? '' : ' panel-collapsed'}`}>
      <header className="topbar">
        <TabStrip
          tabs={tabs}
          activeId={activeTab?.id}
          onActivate={actions.activateTab}
          onClose={actions.closeTab}
          onNew={actions.newTab}
          onNewConversation={actions.newConversation}
        />
        <Omnibox
          activeTab={activeTab}
          onNavigate={actions.navigate}
          onBack={actions.back}
          onForward={actions.forward}
          onReload={actions.reload}
          panelOpen={panelOpen}
          onTogglePanel={togglePanel}
        />
        <button
          className="settings-btn"
          onClick={() => setShowGallery(true)}
          aria-label="saved pages"
          title="Saved pages"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
            <path d="M8 2l1.9 3.9 4.3.6-3.1 3 .8 4.3L8 11.8 4.1 13.8l.8-4.3-3.1-3 4.3-.6z" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className="settings-btn"
          onClick={() => setShowSettings(true)}
          aria-label="settings"
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
          </svg>
        </button>
      </header>

      {showSettings ? <CodexSettings onClose={() => setShowSettings(false)} /> : null}
      {showGallery ? (
        <SavedPagesGallery
          onClose={() => setShowGallery(false)}
          onOpen={actions.openPage}
          onAsk={actions.askPage}
          list={actions.listPages}
        />
      ) : null}

      <main className="stage">
        {tabs.length === 0 ? <Home onPrompt={actions.submit} loading /> : null}
      </main>

      <AgentPanel
        events={events}
        onResolve={actions.resolveUx}
        onResultAction={onResultAction}
        savedPageIds={savedPageIds}
        busy={busy}
      />

      <div className="inputband">
        <FloatingInput
          busy={busy}
          onSubmit={actions.submit}
          onCancel={actions.cancel}
          seed={seed}
        />
      </div>
    </div>
  );
}
