/**
 * useRenderState — subscribes to the main-process IPC streams (tabs + agent
 * events) via the contextBridge `window.render` API and exposes immutable state
 * plus typed action callbacks. The renderer holds NO privileged handles; this
 * hook is the whole of its model.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, TabState } from '@render/protocol';

export interface RenderState {
  tabs: TabState[];
  activeTab: TabState | undefined;
  events: AgentEvent[];
  busy: boolean;
  actions: {
    submit: (text: string) => void;
    cancel: () => void;
    navigate: (url: string) => void;
    newTab: () => void;
    closeTab: (id: string) => void;
    activateTab: (id: string) => void;
    back: () => void;
    forward: () => void;
    reload: () => void;
  };
}

const MAX_EVENTS = 300;

export function useRenderState(): RenderState {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  useEffect(() => {
    const api = window.render;
    void api.getState().then((s) => {
      setTabs(s.tabs);
      if (activeRef.current === null) setActiveId(s.tabs[s.tabs.length - 1]?.id ?? null);
    });

    const offTabs = api.onTabsChanged((next) => {
      setTabs(next);
      // reconcile: if our active tab disappeared, fall back to the last one
      if (!next.some((t) => t.id === activeRef.current)) {
        setActiveId(next[next.length - 1]?.id ?? null);
      }
    });
    const offAgent = api.onAgentEvent((e) => {
      setEvents((prev) => [...prev, e].slice(-MAX_EVENTS));
      if (e.kind === 'turn_started') setBusy(true);
      if (e.kind === 'turn_completed' || e.kind === 'error') setBusy(false);
    });
    return () => {
      offTabs();
      offAgent();
    };
  }, []);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1],
    [tabs, activeId],
  );

  const submit = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed) void window.render.submitPrompt(trimmed);
  }, []);
  const cancel = useCallback(() => void window.render.cancelTurn(), []);
  const navigate = useCallback((url: string) => {
    const id = activeRef.current;
    if (id) void window.render.tabNavigate(id, url);
  }, []);
  const newTab = useCallback(async () => {
    const { tabId } = await window.render.tabCreate();
    setActiveId(tabId);
  }, []);
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

  return {
    tabs,
    activeTab,
    events,
    busy,
    actions: { submit, cancel, navigate, newTab, closeTab, activateTab, back, forward, reload },
  };
}
