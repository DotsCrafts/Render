// <AgentPanel/> — the embeddable right-side agent stream. Consumes an ordered
// AgentEvent[] (main → renderer over IPC) and renders it in place: non-ux events
// as a lightweight feed, ux events (render/form/confirm/login) as interactive,
// catalog-whitelisted surfaces. Blocking surfaces call onResolve(id, result);
// the panel also tracks resolutions locally so a resolved surface goes inert.
import { useCallback, useState } from "react";
import type { AgentEvent, UxResult } from "@render/protocol";
import { UxSurface } from "./UxSurface";
import { FeedItem } from "./EventFeed";

export interface AgentPanelProps {
  events: AgentEvent[];
  onResolve?: (id: string, result: UxResult) => void;
  /** Optional heading shown above the stream. */
  title?: string;
}

export function AgentPanel({ events, onResolve, title }: AgentPanelProps) {
  const [resolved, setResolved] = useState<Record<string, UxResult>>({});

  const handleResolve = useCallback(
    (id: string, result: UxResult) => {
      setResolved((prev) => (prev[id] ? prev : { ...prev, [id]: result }));
      onResolve?.(id, result);
    },
    [onResolve],
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-violet-500" aria-hidden />
        <span className="text-sm font-semibold">{title ?? "Agent"}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          json-render · catalog-whitelisted
        </span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent activity yet.</p>
        ) : (
          events.map((event, i) =>
            event.kind === "ux" ? (
              <UxSurface
                key={event.message.id}
                message={event.message}
                resolved={resolved[event.message.id]}
                onResolve={(result) => handleResolve(event.message.id, result)}
              />
            ) : (
              <FeedItem key={i} event={event} />
            ),
          )
        )}
      </div>
    </div>
  );
}
