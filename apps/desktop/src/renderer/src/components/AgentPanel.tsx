import { useEffect, useMemo, useRef } from 'react';
import type { AgentEvent, UxMessage, UxRenderSpec } from '@render/protocol';
import { foldEvents, type Row } from '../foldEvents.js';

interface Props {
  events: AgentEvent[];
}

/**
 * The right-side agent event-stream panel.
 *
 * For M1 this is a faithful placeholder: it folds the raw `AgentEvent` IPC
 * stream into readable rows. Worker UX swaps the body for the @json-render
 * /shadcn panel later — the mount point (`#agent-panel-mount`) and the
 * `window.render.onAgentEvent` stream are the stable seam it plugs into.
 */
export function AgentPanel({ events }: Props): JSX.Element {
  const rows = useMemo(() => foldEvents(events), [events]);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows]);

  return (
    <aside className="panel">
      <header>
        <span style={{ color: 'var(--brain)' }}>✦</span> Agent
        <span className="badge">{rows.length ? `${rows.length} events` : 'idle'}</span>
      </header>
      <div className="stream" ref={streamRef} id="agent-panel-mount">
        {rows.length === 0 ? (
          <div className="empty">Ask something below — the agent stream appears here.</div>
        ) : (
          rows.map((row) => <EventRow key={row.key} row={row} />)
        )}
      </div>
    </aside>
  );
}

function EventRow({ row }: { row: Row }): JSX.Element {
  if (row.kind === 'ux') return <UxCard message={row.message} />;
  return (
    <div className={`evt ${row.tone}`}>
      <div className="k">{row.label}</div>
      {row.text ? <pre>{row.text}</pre> : null}
    </div>
  );
}

function UxCard({ message }: { message: UxMessage }): JSX.Element {
  if (message.kind === 'render') {
    // `spec` is a conditional type keyed off `kind`; TS can't narrow it from the
    // runtime check, so we assert the render shape we just discriminated on.
    const spec = message.spec as UxRenderSpec;
    return (
      <div className="evt ux ux-card">
        <div className="k">ux · render{message.blocking ? ' · blocking' : ''}</div>
        {spec.title ? <div className="ux-title">{spec.title}</div> : null}
        {spec.body ? <div>{spec.body}</div> : null}
        {(spec.items ?? []).map((item, i) => (
          <div className="ux-item" key={i}>
            {item.title ? <strong>{item.title}</strong> : null}
            {item.subtitle ? <div>{item.subtitle}</div> : null}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="evt ux">
      <div className="k">ux · {message.kind}{message.blocking ? ' · blocking' : ''}</div>
      <pre>{JSON.stringify(message.spec, null, 2)}</pre>
    </div>
  );
}
