// The agent stream, reorganized around "elevate the answer, demote the process".
//
// Raw AgentEvents are grouped into ordered blocks: human prompts and answers
// (agent messages / ux surfaces) stay first-class, while the process — turns,
// reasoning, tool/command runs and sandbox lifecycle — collapses into a single
// quiet, collapsible "activity lane". Errors stay visible. This file owns the
// grouping (`groupEvents`) and the non-surface block renderers; AgentPanel
// composes them and interleaves the ux surfaces.
import { useState } from "react";
import type { AgentEvent, CodexItem } from "@render/protocol";

// ── block model ──────────────────────────────────────────────────────────────

export interface ActivityStep {
  kind: "reason" | "command" | "you" | "muted" | "error";
  key: string;
  text: string;
}

export type Block =
  | { type: "human"; key: string; text: string }
  | { type: "answer"; key: string; text: string }
  | { type: "surface"; key: string; index: number }
  | { type: "error"; key: string; text: string }
  | { type: "activity"; key: string; steps: ActivityStep[]; durationMs?: number };

function commandStep(item: CodexItem): ActivityStep {
  const exit =
    typeof item.exitCode === "number" ? ` → exit ${item.exitCode}` : "";
  return {
    kind: "command",
    key: "$",
    text: `${item.command ?? ""}${exit}`.trim(),
  };
}

/** Fold the ordered event list into ordered, render-ready blocks. */
export function groupEvents(events: AgentEvent[]): Block[] {
  const blocks: Block[] = [];
  let lane: Extract<Block, { type: "activity" }> | null = null;

  const pushStep = (step: ActivityStep): void => {
    if (!lane) {
      lane = { type: "activity", key: `act-${blocks.length}`, steps: [] };
      blocks.push(lane);
    }
    lane.steps.push(step);
  };
  const breakLane = (): void => {
    lane = null;
  };

  events.forEach((event, i) => {
    switch (event.kind) {
      case "ux":
        breakLane();
        blocks.push({ type: "surface", key: event.message.id, index: i });
        return;
      case "error":
        breakLane();
        blocks.push({ type: "error", key: `err-${i}`, text: event.message });
        return;
      case "item": {
        if (event.phase === "started") return; // avoid dupes; use completed
        const item = event.item;
        if (item.type === "userMessage") {
          breakLane();
          blocks.push({ type: "human", key: `you-${i}`, text: item.text ?? "" });
          return;
        }
        if (item.type === "agentMessage") {
          breakLane();
          if (item.text?.trim())
            blocks.push({ type: "answer", key: `ans-${i}`, text: item.text });
          return;
        }
        if (item.type === "commandExecution") {
          pushStep(commandStep(item));
          return;
        }
        // plan / fileChange / mcpToolCall / unknown → a quiet muted step
        pushStep({
          kind: "muted",
          key: item.type,
          text: item.text ?? "",
        });
        return;
      }
      case "reasoning":
        pushStep({ kind: "reason", key: "reason", text: event.text });
        return;
      case "sandbox":
        pushStep({
          kind: "muted",
          key: "sbx",
          text: `${event.provider} · ${event.status}`,
        });
        return;
      case "turn_completed":
        if (lane && typeof event.durationMs === "number") {
          lane.durationMs = (lane.durationMs ?? 0) + event.durationMs;
        }
        return;
      case "turn_started":
      case "delta":
        return; // pure liveness noise — surfaced via the streaming affordance
      default:
        return;
    }
  });

  return blocks;
}

// ── block renderers ──────────────────────────────────────────────────────────

export function HumanTurn({ text }: { text: string }) {
  return (
    <div className="rd-human">
      <span className="rd-human-avatar" aria-hidden>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="5" r="2.6" />
          <path d="M3 13.2c.7-2.4 2.6-3.6 5-3.6s4.3 1.2 5 3.6" strokeLinecap="round" />
        </svg>
      </span>
      <div className="rd-human-text">{text}</div>
    </div>
  );
}

export function AnswerCard({ text }: { text: string }) {
  return (
    <div className="rd-answer">
      <div className="rd-answer-head">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--agent)" strokeWidth="1.5" style={{ flex: "none" }}>
          <rect x="3" y="3" width="10" height="10" rx="2.4" />
          <path d="M6 6.2h4M6 8h4M6 9.8h2.4" strokeWidth="1.3" />
        </svg>
        <span className="label">Answer</span>
      </div>
      <div className="rd-answer-body">{text}</div>
    </div>
  );
}

export function ErrorRow({ text }: { text: string }) {
  return (
    <div className="rd-step error" role="alert">
      <span className="rd-step-key">error</span>
      <span className="rd-step-val">{text}</span>
    </div>
  );
}

export function ActivityLane({
  steps,
  durationMs,
  defaultOpen,
}: {
  steps: ActivityStep[];
  durationMs?: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const n = steps.length;
  const dur =
    typeof durationMs === "number" && durationMs > 0
      ? `Worked for ${(durationMs / 1000).toFixed(durationMs >= 9950 ? 0 : 1)}s · `
      : "";
  const preview = steps[steps.length - 1]?.text ?? "";

  return (
    <div className="rd-activity">
      <button
        type="button"
        className="rd-activity-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--command)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
          <circle cx="8" cy="8" r="6.2" strokeOpacity="0.4" />
          <path d="M5.4 8.2l1.7 1.7 3.5-3.8" />
        </svg>
        <span className="rd-activity-summary">
          {dur}
          {n} step{n === 1 ? "" : "s"}
        </span>
        {!open && preview ? (
          <span className="rd-activity-meta">· {preview}</span>
        ) : null}
        <span className="rd-spacer" />
        <svg className={`rd-chevron${open ? " open" : ""}`} width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5.5l3 3 3-3" />
        </svg>
      </button>
      {open ? (
        <div className="rd-activity-body">
          {steps.map((s, i) => (
            <div key={i} className={`rd-step ${s.kind}`}>
              <span className="rd-step-key">{s.key}</span>
              <span className="rd-step-val">{s.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
