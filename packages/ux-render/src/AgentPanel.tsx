// <AgentPanel/> — the embeddable right-side agent stream. Consumes an ordered
// AgentEvent[] (main → renderer over IPC) and renders it around one idea:
// "elevate the answer, demote the process". Human prompts and answers (agent
// messages + ux render/form/confirm/login surfaces) are first-class; turns,
// reasoning, tool runs and sandbox lifecycle collapse into a quiet activity
// lane (expand-on-demand, or all-open via the Verbose toggle). A streaming
// affordance and auto-scroll keep a running turn legible. Blocking surfaces
// call onResolve(id, result); resolutions are tracked locally so a resolved
// surface goes inert.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, UxMessage, UxResult } from "@render/protocol";
import { UxSurface } from "./UxSurface";
import type { ResultAction } from "./surfaces/ResultActions";
import {
  ActivityLane,
  AnswerCard,
  ErrorRow,
  HumanTurn,
  groupEvents,
} from "./EventFeed";

export interface AgentPanelProps {
  events: AgentEvent[];
  onResolve?: (id: string, result: UxResult) => void;
  /** Delta 2: a next-step action fired from a result card (Refine / Save / …). */
  onResultAction?: (action: ResultAction, message: UxMessage) => void;
  /** Delta 3: page ids already saved this session — marks their Save button done. */
  savedPageIds?: Set<string>;
  /** Optional heading shown above the stream. */
  title?: string;
  /** True while a turn is running — drives the working dot + streaming row. */
  busy?: boolean;
}

export function AgentPanel({
  events,
  onResolve,
  onResultAction,
  savedPageIds,
  title,
  busy,
}: AgentPanelProps) {
  const [resolved, setResolved] = useState<Record<string, UxResult>>({});
  const [verbose, setVerbose] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleResolve = useCallback(
    (id: string, result: UxResult) => {
      setResolved((prev) => (prev[id] ? prev : { ...prev, [id]: result }));
      onResolve?.(id, result);
    },
    [onResolve],
  );

  // Copy the full event stream as JSON — useful for debugging / sharing a turn.
  // Kept from the pre-redesign panel, now a quiet header icon. Falls back to a
  // hidden textarea + execCommand where the async clipboard API is blocked.
  const copyAll = useCallback(async () => {
    const text = JSON.stringify(events, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up silently */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [events]);

  const blocks = useMemo(() => groupEvents(events), [events]);

  // — auto-scroll: stick to the bottom unless the user has scrolled up —
  const feedRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);
  useEffect(() => {
    const el = feedRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks.length, busy]);

  // a turn is "answering" once the last block is an answer/surface; before that
  // (busy, nothing emitted yet) we show a skeleton instead of a typing row.
  const lastBlock = blocks[blocks.length - 1];
  const showSkeleton = busy && (!lastBlock || lastBlock.type === "human");

  return (
    <div className="rd-panel">
      <div className="rd-panel-head">
        <div className="rd-panel-id">
          <span className={`rd-status${busy ? " working" : ""}`} aria-hidden>
            <span className="dot" />
            <span className="ring" />
          </span>
          <span className="rd-panel-title">{title ?? "Agent"}</span>
          <span className="rd-panel-sub">{busy ? "working" : "ready"}</span>
        </div>
        <span className="rd-spacer" />
        <button
          type="button"
          className={`rd-toggle${verbose ? " on" : ""}`}
          onClick={() => setVerbose((v) => !v)}
          title="Show the agent's reasoning and tool calls"
          aria-pressed={verbose}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M1 7h12M1 3.5h12M1 10.5h7" />
          </svg>
          {verbose ? "Verbose" : "Quiet"}
        </button>
        <button
          type="button"
          className={`rd-iconbtn${copied ? " ok" : ""}`}
          onClick={copyAll}
          disabled={events.length === 0}
          title="Copy the full event stream as JSON"
          aria-label={copied ? "copied" : "copy event stream"}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 8.5l3 3 6-6.5" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
              <path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" />
            </svg>
          )}
        </button>
      </div>

      <div className="rd-feed" ref={feedRef} onScroll={onScroll}>
        {blocks.length === 0 && !busy ? (
          <p className="rd-empty">
            Ask Render to do something and the agent's work and answer will
            appear here.
          </p>
        ) : (
          blocks.map((block) => {
            switch (block.type) {
              case "human":
                return <HumanTurn key={block.key} text={block.text} />;
              case "answer":
                return <AnswerCard key={block.key} text={block.text} />;
              case "error":
                return <ErrorRow key={block.key} text={block.text} />;
              case "activity":
                return (
                  <ActivityLane
                    key={block.key}
                    steps={block.steps}
                    durationMs={block.durationMs}
                    defaultOpen={verbose}
                  />
                );
              case "surface": {
                const event = events[block.index] as Extract<
                  AgentEvent,
                  { kind: "ux" }
                >;
                // reflect a session-local save without mutating the buffered event
                const m = event.message;
                const message =
                  m.page && savedPageIds?.has(m.page.id)
                    ? { ...m, page: { ...m.page, saved: true } }
                    : m;
                return (
                  <UxSurface
                    key={block.key}
                    message={message}
                    resolved={resolved[m.id]}
                    onResolve={(result) => handleResolve(m.id, result)}
                    {...(onResultAction ? { onAction: onResultAction } : {})}
                  />
                );
              }
              default:
                return null;
            }
          })
        )}

        {showSkeleton ? (
          <div className="rd-skeleton" aria-hidden>
            <div className="rd-skeleton-line" style={{ width: "92%" }} />
            <div className="rd-skeleton-line" style={{ width: "78%" }} />
            <div className="rd-skeleton-line" style={{ width: "60%" }} />
          </div>
        ) : busy ? (
          <div className="rd-typing" aria-label="agent is working">
            <svg className="ico" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2v3M8 11v3M2 8h3M11 8h3" strokeOpacity="0.9" />
            </svg>
            <span>Working</span>
            <span className="rd-typing-dots">
              <span />
              <span />
              <span />
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
