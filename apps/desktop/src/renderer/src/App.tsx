import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { UxMessage } from '@render/protocol';
import type { ResultAction } from '@render/ux-render';
import { useRenderState } from './useRenderState.js';
import { TabStrip } from './components/TabStrip.js';
import { Omnibox } from './components/Omnibox.js';
import { FloatingInput } from './components/FloatingInput.js';
import { AgentPanel } from './components/AgentPanel.js';
import { CodexSettings } from './components/CodexSettings.js';
import { Connectors } from './components/Connectors.js';
import { SavedPagesGallery } from './components/SavedPagesGallery.js';
import { Home } from './components/Home.js';

/**
 * The browser chrome (untrusted display). The real web pages are native
 * WebContentsViews painted by the main process into the `.stage` region; this
 * React tree only draws the surrounding chrome and talks to main over IPC.
 */
export function App(): ReactElement {
  const { tabs, activeTab, events, busy, resolvedUxIds, restoredInputOpen, actions } =
    useRenderState();
  const [showSettings, setShowSettings] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  // The floating input is a summonable LAYER, not a fixed band: ⌘K / the recall
  // handle / the toolbar button summon it; Esc dismisses it and pages reclaim
  // the space (main re-insets the native views to match). `null` = not yet
  // adopted from main — a reload must inherit a dismissed state instead of
  // re-summoning it (that would jump pages 62px and occlude the pill).
  const [inputOpen, setInputOpen] = useState<boolean | null>(null);
  const inputShown = inputOpen !== false;
  // Delta 2: a seeded prefill for the floating input (Refine / Ask follow-up).
  const [seed, setSeed] = useState<{ text: string; nonce: number }>({ text: '', nonce: 0 });
  // ⌘K focus signal for the floating input (draft-preserving, unlike seed).
  const [focusNonce, setFocusNonce] = useState(0);
  // Delta 3: pages saved this session — marks their card's Save button done.
  const [savedPageIds, setSavedPageIds] = useState<Set<string>>(() => new Set());

  // Native page views composite over the chrome renderer, so they'd occlude any
  // renderer modal (settings / saved-pages gallery / connectors). Hide them
  // while one is open — and pull focus out of the (visually suppressed) input
  // layer so Esc can't dismiss an input the user can no longer see.
  const modalOpen = showSettings || showGallery || showConnectors;
  useEffect(() => {
    void window.render.setOverlay(modalOpen);
    if (modalOpen) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('.inputband')) active.blur();
    }
  }, [modalOpen]);

  // Adopt main's input-layer state once on load (reload restores a dismissed
  // input); user toggles that land before getState resolves win over it.
  useEffect(() => {
    if (restoredInputOpen !== null) {
      setInputOpen((current) => (current === null ? restoredInputOpen : current));
    }
  }, [restoredInputOpen]);

  // Keep main's page-view insets in lockstep with the input layer's visibility.
  // No IPC until the state is adopted — main already holds the truth then.
  useEffect(() => {
    if (inputOpen !== null) void window.render.setInputOpen(inputOpen);
  }, [inputOpen]);

  // Summon = show + focus. The input stays mounted while dismissed (drafts
  // survive), so summoning is just a class flip + a focus nonce bump.
  const summonInput = useCallback(() => {
    setInputOpen(true);
    setFocusNonce((n) => n + 1);
  }, []);

  // ⌘K / Ctrl+K — the advertised keyboard path to the intent input, wired
  // twice on purpose: the app-menu accelerator reaches us from ANY focus state
  // (incl. native page views — it hands focus back, then pushes onSummonInput),
  // and this renderer listener is the fallback wherever accelerator delivery
  // differs. Both funnel into the same idempotent summon.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        summonInput();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [summonInput]);
  useEffect(() => window.render.onSummonInput(summonInput), [summonInput]);

  // Delta 2: route a result card's next-step action. Refine/Ask-follow-up seed the
  // floating input; Save persists the page; Open-as-page asks the agent to build
  // one; Ask-agent pulls a saved page back into the conversation (Delta 5).
  const onResultAction = useCallback(
    (action: ResultAction, message: UxMessage) => {
      switch (action) {
        case 'refine':
          setInputOpen(true); // a seeded prefill needs the input layer visible
          setSeed((s) => ({ text: 'Refine the previous result: ', nonce: s.nonce + 1 }));
          break;
        case 'follow_up':
          setInputOpen(true);
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
    <div className={`app${panelOpen ? '' : ' panel-collapsed'}${modalOpen ? ' modal-open' : ''}`}>
      <header className="topbar">
        <TabStrip
          tabs={tabs}
          activeId={activeTab?.id}
          onActivate={actions.activateTab}
          onClose={actions.closeTab}
          onNew={actions.newTab}
          onNewConversation={actions.newConversation}
        />
        <div className="omnirow">
          <Omnibox
            activeTab={activeTab}
            onNavigate={actions.navigate}
            onBack={actions.back}
            onForward={actions.forward}
            onReload={actions.reload}
            panelOpen={panelOpen}
            onTogglePanel={togglePanel}
          />
          <div className="chrome-actions" role="toolbar" aria-label="Render tools">
            <button
              className={`settings-btn${inputShown ? ' on' : ''}`}
              onClick={() => (inputShown ? setInputOpen(false) : summonInput())}
              aria-label="ask render"
              aria-pressed={inputShown}
              title="Ask Render (⌘K)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                <rect x="1.5" y="4.5" width="13" height="7.5" rx="2.4" />
                <path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.6h6" strokeLinecap="round" />
              </svg>
            </button>
            <span className="chrome-actions-sep" aria-hidden />
            <button
              className="settings-btn"
              onClick={() => setShowConnectors(true)}
              aria-label="connectors"
              title="Connectors — site logins the agent can use"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                <path d="M6 1.5v3M10 1.5v3" strokeLinecap="round" />
                <path d="M4.5 4.5h7v3.2a3.5 3.5 0 01-7 0z" strokeLinejoin="round" />
                <path d="M8 11.2v1.6a1.7 1.7 0 01-1.7 1.7H4.8" strokeLinecap="round" />
              </svg>
            </button>
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
          </div>
        </div>
      </header>

      {showSettings ? <CodexSettings onClose={() => setShowSettings(false)} /> : null}
      {showConnectors ? <Connectors onClose={() => setShowConnectors(false)} /> : null}
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
        initialResolvedIds={resolvedUxIds}
        busy={busy}
      />

      <div className={`inputband${inputShown ? ' open' : ''}${busy ? ' busy' : ''}`}>
        <FloatingInput
          busy={busy}
          onSubmit={actions.submit}
          onSteer={actions.steer}
          onCancel={actions.cancel}
          onDismiss={() => setInputOpen(false)}
          seed={seed}
          focusNonce={focusNonce}
        />
        <button
          className="input-summon"
          onClick={summonInput}
          tabIndex={inputShown ? -1 : 0}
          aria-label="Ask Render (⌘K)"
          aria-hidden={inputShown}
          title="Ask Render (⌘K)"
        >
          <span className="input-summon-bar" aria-hidden />
        </button>
      </div>
    </div>
  );
}
