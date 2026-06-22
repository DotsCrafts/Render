import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import type { AgentEvent, UxResult } from '@render/protocol';
import { AgentPanel as UxAgentPanel } from '@render/ux-render';

interface Props {
  events: AgentEvent[];
  onResolve: (id: string, result: UxResult) => void;
}

/**
 * The right-side agent panel: the real @render/ux-render panel fed by the IPC
 * AgentEvent stream, plus a left-edge drag handle to resize it (so wide/tall
 * dynamic UIs — tables, grids — aren't clipped). The drag updates the CSS var
 * immediately and tells main to re-inset the page views (throttled to rAF).
 */
export function AgentPanel({ events, onResolve }: Props): ReactElement {
  return (
    <aside className="panel">
      <PanelResizeHandle />
      <UxAgentPanel events={events} onResolve={onResolve} title="Agent" />
    </aside>
  );
}

const MIN = 300;
const MAX = 820;

function PanelResizeHandle(): ReactElement {
  const dragging = useRef(false);
  const raf = useRef<number | null>(null);
  const pending = useRef<number | null>(null);

  const flush = (): void => {
    raf.current = null;
    if (pending.current != null) {
      void window.render.setPanelWidth(pending.current);
      pending.current = null;
    }
  };

  const apply = (width: number): void => {
    document.documentElement.style.setProperty('--panel-width', `${width}px`);
    pending.current = width;
    if (raf.current == null) raf.current = requestAnimationFrame(flush);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('dragging');
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    apply(Math.max(MIN, Math.min(MAX, window.innerWidth - e.clientX)));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.classList.remove('dragging');
    if (raf.current != null) cancelAnimationFrame(raf.current);
    flush(); // final sync
  };

  return (
    <div
      className="panel-resize"
      title="Drag to resize the agent panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
