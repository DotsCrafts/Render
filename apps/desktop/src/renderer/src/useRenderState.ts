/**
 * useRenderState — subscribes to the main-process IPC streams (tabs + agent
 * events) via the contextBridge `window.render` API and exposes immutable state
 * plus typed action callbacks. The renderer holds NO privileged handles; this
 * hook is the whole of its model.
 *
 * Buffering policy (merge, cap, turn tracking) lives in agent-event-buffer.ts;
 * `busy` derives from the set of open turns — never from error events, which
 * are just feed rows. Every IPC action catches its rejection and surfaces it
 * as a synthetic error event, so a failed submit/steer/reply is never silent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, SavedPageMeta, TabState, UxResult } from '@render/protocol';
import {
  appendEvent,
  computeOpenTurns,
  reduceOpenTurns,
} from './agent-event-buffer.js';

export interface RenderState {
  tabs: TabState[];
  activeTab: TabState | undefined;
  events: AgentEvent[];
  busy: boolean;
  /** ux message ids resolved before a renderer reload (replayed from main). */
  resolvedUxIds: string[];
  actions: {
    submit: (text: string) => void;
    /** steer the RUNNING turn (mid-run refinement) instead of starting one */
    steer: (text: string) => void;
    cancel: () => void;
    resolveUx: (id: string, result: UxResult) => void;
    navigate: (url: string) => void;
    newTab: () => void;
    newConversation: () => void;
    closeTab: (id: string) => void;
    activateTab: (id: string) => void;
    back: () => void;
    forward: () => void;
    reload: () => void;
    // saved render-pages (Delta 3)
    savePage: (id: string) => Promise<void>;
    listPages: () => Promise<SavedPageMeta[]>;
    openPage: (id: string) => Promise<boolean>;
    askPage: (id: string, instruction: string) => void;
  };
}

export function useRenderState(): RenderState {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  // busy = at least one turn open; see agent-event-buffer.ts for lifecycle rules
  const [openTurns, setOpenTurns] = useState<readonly string[]>([]);
  const [resolvedUxIds, setResolvedUxIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  // An IPC action that rejects (agent boot failure, dead codex, missing binary)
  // must not evaporate — surface it as an error row in the feed.
  const appendLocalError = useCallback((context: string, err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    setEvents((prev) => appendEvent(prev, { kind: 'error', message: `${context}: ${detail}` }));
  }, []);

  useEffect(() => {
    const api = window.render;
    api
      .getState()
      .then((s) => {
        setTabs(s.tabs);
        if (s.events && s.events.length) {
          // replay the buffered agent stream so a renderer reload doesn't wipe it;
          // run it back through the same append policy (merge + cap)…
          setEvents(s.events.reduce(appendEvent, [] as AgentEvent[]));
          // …and recompute the open turns from the FULL log, so a reload
          // mid-turn comes back showing "working" with a live Stop button.
          setOpenTurns(computeOpenTurns(s.events));
        }
        // resolutions recorded before the reload — their cards render inert
        if (s.resolvedUxIds && s.resolvedUxIds.length) setResolvedUxIds(s.resolvedUxIds);
        if (activeRef.current === null) setActiveId(s.tabs[s.tabs.length - 1]?.id ?? null);
      })
      .catch((err) => appendLocalError('load state failed', err));

    const offTabs = api.onTabsChanged((next) => {
      setTabs(next);
      // reconcile: if our active tab disappeared, fall back to the last one
      if (!next.some((t) => t.id === activeRef.current)) {
        setActiveId(next[next.length - 1]?.id ?? null);
      }
    });
    const offAgent = api.onAgentEvent((e) => {
      setEvents((prev) => appendEvent(prev, e));
      setOpenTurns((prev) => reduceOpenTurns(prev, e));
    });
    return () => {
      offTabs();
      offAgent();
    };
  }, [appendLocalError]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1],
    [tabs, activeId],
  );

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed) {
        window.render
          .submitPrompt(trimmed)
          .catch((err) => appendLocalError('submit failed', err));
      }
    },
    [appendLocalError],
  );
  // steer routes into the RUNNING turn (turn/steer) — used by the floating
  // input while busy, so a mid-run follow-up refines instead of competing.
  const steer = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed) {
        window.render.steerTurn(trimmed).catch((err) => appendLocalError('steer failed', err));
      }
    },
    [appendLocalError],
  );
  const cancel = useCallback(() => {
    window.render.cancelTurn().catch((err) => appendLocalError('stop failed', err));
  }, [appendLocalError]);
  const resolveUx = useCallback(
    (id: string, result: UxResult) => {
      window.render
        .resolveUx(id, result)
        .catch((err) => appendLocalError('reply failed', err));
    },
    [appendLocalError],
  );
  const navigate = useCallback((url: string) => {
    const id = activeRef.current;
    if (id) void window.render.tabNavigate(id, url);
  }, []);
  const newTab = useCallback(async () => {
    const { tabId } = await window.render.tabCreate();
    setActiveId(tabId);
  }, []);
  // New group ⟺ new conversation: starts a fresh codex thread + tab group.
  // The agent's next tabs land in the new group; no tab is opened up front.
  const newConversation = useCallback(() => {
    window.render
      .newConversation()
      .catch((err) => appendLocalError('new conversation failed', err));
  }, [appendLocalError]);
  const closeTab = useCallback((id: string) => void window.render.tabClose(id), []);
  const activateTab = useCallback((id: string) => {
    setActiveId(id);
    void window.render.tabActivate(id);
  }, []);
  const back = useCallback(() => {
    const id = activeRef.current;
    if (id) void window.renderChrome.back(id);
  }, []);
  const forward = useCallback(() => {
    const id = activeRef.current;
    if (id) void window.renderChrome.forward(id);
  }, []);
  const reload = useCallback(() => {
    const id = activeRef.current;
    if (id) void window.renderChrome.reload(id);
  }, []);

  // saved render-pages (Delta 3): savePage flips a delivered page to saved; the
  // gallery (listPages) shows those; openPage re-serves a saved spec into a tab;
  // askPage pulls a page back into the conversation for a new version (Delta 5).
  const savePage = useCallback(async (id: string) => {
    await window.render.savePage(id);
  }, []);
  const listPages = useCallback(() => window.render.listPages(), []);
  const openPage = useCallback((id: string) => window.render.openPage(id), []);
  const askPage = useCallback(
    (id: string, instruction: string) => {
      window.render
        .askPage(id, instruction)
        .catch((err) => appendLocalError('ask-page failed', err));
    },
    [appendLocalError],
  );

  return {
    tabs,
    activeTab,
    events,
    busy: openTurns.length > 0,
    resolvedUxIds,
    actions: {
      submit,
      steer,
      cancel,
      resolveUx,
      navigate,
      newTab,
      newConversation,
      closeTab,
      activateTab,
      back,
      forward,
      reload,
      savePage,
      listPages,
      openPage,
      askPage,
    },
  };
}
