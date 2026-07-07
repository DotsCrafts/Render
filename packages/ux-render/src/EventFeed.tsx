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
  /** codex item id — lets started→completed upgrades and reasoning merges target this step */
  itemId?: string;
  /** true for a commandExecution that has started but not yet completed */
  pending?: boolean;
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

// `render-open` / `render-page` are Render-owned shims: the main process
// intercepts their COMPLETED events (opening the tab / delivering the page),
// so the raw sentinel command must not leak into the feed at the started
// phase either. Matches raw and shell-wrapped forms (`zsh -lc 'render-open …'`).
const RENDER_SHIM_RE = /(?:^|[\s;&|/"'])render-(?:open|page)\b/;
const isRenderShim = (command: string | undefined): boolean =>
  !!command && RENDER_SHIM_RE.test(command);

/** Fold the ordered event list into ordered, render-ready blocks. */
export function groupEvents(events: AgentEvent[]): Block[] {
  const blocks: Block[] = [];
  let lane: Extract<Block, { type: "activity" }> | null = null;
  // started commandExecutions by item id — upgraded IN PLACE on completion so
  // a command renders exactly one row (spinner while running, exit when done).
  const runningCommands = new Map<string, ActivityStep>();

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
  // The trailing reason step, when its item id is compatible (equal, or either
  // absent — AgentEvent.itemId is optional): codex streams reasoning as many
  // tiny fragments, which merge into one readable step instead of one row each.
  const trailingReason = (itemId: string | undefined): ActivityStep | null => {
    const last = lane?.steps[lane.steps.length - 1];
    if (!last || last.kind !== "reason") return null;
    if (last.itemId && itemId && last.itemId !== itemId) return null;
    return last;
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
        const item = event.item;
        const itemId = typeof item.id === "string" ? item.id : undefined;
        if (event.phase === "started") {
          // Mid-turn streaming: a started command shows immediately as an
          // in-progress step; every other item kind still waits for completion.
          if (item.type !== "commandExecution") return;
          if (isRenderShim(item.command)) return;
          const step: ActivityStep = {
            kind: "command",
            key: "$",
            text: `${item.command ?? ""}`.trim(),
            pending: true,
            ...(itemId ? { itemId } : {}),
          };
          if (itemId) runningCommands.set(itemId, step);
          pushStep(step);
          return;
        }
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
          if (isRenderShim(item.command)) return;
          const done = commandStep(item);
          const started = itemId ? runningCommands.get(itemId) : undefined;
          if (started && itemId) {
            // upgrade the in-progress row in place — no duplicate rows
            runningCommands.delete(itemId);
            started.text = done.text;
            started.pending = false;
            return;
          }
          pushStep(done);
          return;
        }
        if (item.type === "reasoning") {
          // the completed reasoning item carries the FULL text — replace the
          // accumulated fragment step rather than adding a duplicate
          const prev = trailingReason(itemId);
          const full = item.text ?? "";
          if (prev) {
            if (full.trim()) prev.text = full;
            return;
          }
          if (full.trim())
            pushStep({
              kind: "reason",
              key: "reason",
              text: full,
              ...(itemId ? { itemId } : {}),
            });
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
      case "reasoning": {
        const prev = trailingReason(event.itemId);
        if (prev) {
          prev.text = `${prev.text}${event.text}`;
          return;
        }
        pushStep({
          kind: "reason",
          key: "reason",
          text: event.text,
          ...(event.itemId ? { itemId: event.itemId } : {}),
        });
        return;
      }
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

  // ux surfaces dedupe LAST-WINS by message id: the runtime re-emits updated
  // cards (e.g. a streaming draft answer) under a stable id — the last emission
  // replaces earlier ones, rendered at the LAST occurrence's position.
  const lastSurfacePos = new Map<string, number>();
  blocks.forEach((b, pos) => {
    if (b.type === "surface") lastSurfacePos.set(b.key, pos);
  });
  return blocks.filter(
    (b, pos) => b.type !== "surface" || lastSurfacePos.get(b.key) === pos,
  );
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
  // "N steps" counts real work (commands / tool calls) — reasoning narration
  // would otherwise inflate the count into the hundreds on a chatty model.
  const n = steps.filter((s) => s.kind === "command" || s.kind === "muted").length;
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
          {n > 0 ? `${n} step${n === 1 ? "" : "s"}` : "reasoning"}
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
            <div key={i} className={`rd-step ${s.kind}${s.pending ? " pending" : ""}`}>
              <span className="rd-step-key">{s.key}</span>
              <span className="rd-step-val">{s.text}</span>
              {s.pending ? (
                <span className="rd-step-run" aria-label="running">
                  …
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
