// Lightweight, trusted event feed for the non-ux AgentEvent kinds — the
// surrounding agent stream (turn lifecycle, items, deltas, reasoning, sandbox,
// errors). This is host chrome, not LLM-authored specs, so it's plain Tailwind.
import type { AgentEvent, CodexItem } from "@render/protocol";

function Row({
  tone,
  label,
  children,
}: {
  tone: string;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-2 text-sm leading-relaxed">
      <span className={`font-mono text-[10px] uppercase tracking-wide mt-1 shrink-0 ${tone}`}>
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function ItemRow({ item }: { item: CodexItem }) {
  if (item.type === "commandExecution") {
    return (
      <Row tone="text-emerald-500" label="cmd">
        <pre className="whitespace-pre-wrap font-mono text-xs rounded-md bg-muted/60 px-2 py-1.5 overflow-x-auto">
          <span className="text-muted-foreground">$ </span>
          {item.command ?? ""}
          {typeof item.exitCode === "number" ? (
            <span className="text-muted-foreground"> → exit {item.exitCode}</span>
          ) : null}
          {item.stdout ? `\n${item.stdout}` : ""}
        </pre>
      </Row>
    );
  }
  if (item.type === "agentMessage" || item.type === "userMessage") {
    return (
      <Row
        tone={item.type === "userMessage" ? "text-blue-500" : "text-foreground/60"}
        label={item.type === "userMessage" ? "you" : "msg"}
      >
        <p className="text-foreground/90">{item.text}</p>
      </Row>
    );
  }
  return (
    <Row tone="text-muted-foreground" label={item.type}>
      {item.text ? <p className="text-muted-foreground">{item.text}</p> : null}
    </Row>
  );
}

export function FeedItem({ event }: { event: AgentEvent }) {
  switch (event.kind) {
    case "turn_started":
      return (
        <Row tone="text-muted-foreground" label="turn">
          <span className="text-muted-foreground">
            started <span className="font-mono">{event.turnId}</span>
          </span>
        </Row>
      );
    case "turn_completed":
      return (
        <Row tone="text-muted-foreground" label="turn">
          <span className="text-muted-foreground">
            {event.status}
            {typeof event.durationMs === "number" ? ` · ${event.durationMs}ms` : ""}
          </span>
        </Row>
      );
    case "item":
      // Only render completed items (or items with no phase) to avoid duplicates.
      return event.phase === "started" ? null : <ItemRow item={event.item} />;
    case "delta":
      return (
        <Row tone="text-foreground/60" label="…">
          <span className="text-foreground/90">{event.text}</span>
        </Row>
      );
    case "reasoning":
      return (
        <Row tone="text-violet-500" label="think">
          <p className="italic text-muted-foreground">{event.text}</p>
        </Row>
      );
    case "sandbox":
      return (
        <Row tone="text-amber-500" label="sbx">
          <span className="text-muted-foreground">
            {event.provider} · {event.status}
          </span>
        </Row>
      );
    case "error":
      return (
        <Row tone="text-red-500" label="err">
          <p className="text-red-500">{event.message}</p>
        </Row>
      );
    default:
      return null;
  }
}
