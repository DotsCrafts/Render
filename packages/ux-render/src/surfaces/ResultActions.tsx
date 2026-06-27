// Delta 2 — the quiet next-step row under a RESULT card. Converts a terminal
// answer into a steering point: Refine · Open as page · Save · Ask follow-up.
// These are HOST actions (they reach IPC), so the surface only emits an intent;
// the desktop shell (AgentPanel wrapper → App) decides what each one does.
//
// Page-aware: a card that opened a savable Tier-2 page (message.page set) shows
// Save (or "Saved ✓") + "Ask agent"; a plain answer card shows "Open as page".
import type { UxMessage } from "@render/protocol";

export type ResultAction =
  | "refine"
  | "open_page"
  | "save"
  | "follow_up"
  | "ask_agent";

const ICON: Record<ResultAction, React.ReactNode> = {
  refine: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" />
    </svg>
  ),
  open_page: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
      <path d="M2.5 6h11M9.5 9.5h2.5M9.5 11h2" />
    </svg>
  ),
  save: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11.9 4.5 12.7l.8-3.9L2.4 6.1l3.9-.5z" />
    </svg>
  ),
  follow_up: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4.5h10v6H7l-3 2.5V10.5H3z" />
    </svg>
  ),
  ask_agent: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v2M8 2a4 4 0 014 4c0 2-1.5 2.7-1.5 4.5h-5C5.5 8.7 4 8 4 6a4 4 0 014-4zM6 13h4M6.5 14.5h3" />
    </svg>
  ),
};

const LABEL: Record<ResultAction, string> = {
  refine: "Refine",
  open_page: "Open as page",
  save: "Save",
  follow_up: "Ask follow-up",
  ask_agent: "Ask agent",
};

export function ResultActions({
  message,
  onAction,
}: {
  message: UxMessage;
  onAction: (action: ResultAction, message: UxMessage) => void;
}) {
  const page = message.page;
  // Page cards: Save/Saved + Ask-agent. Plain answer cards: Open-as-page.
  const actions: ResultAction[] = page
    ? ["refine", "ask_agent", "save", "follow_up"]
    : ["refine", "open_page", "follow_up"];

  return (
    <div className="rd-result-actions">
      {actions.map((a) => {
        const saved = a === "save" && page?.saved;
        return (
          <button
            key={a}
            type="button"
            className={`rd-result-action${saved ? " saved" : ""}`}
            onClick={() => onAction(a, message)}
            disabled={saved}
            title={saved ? "Saved to your gallery" : LABEL[a]}
          >
            <span className="rd-result-action-ico" aria-hidden>
              {saved ? (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3.5 8.5l3 3 6-6.5" />
                </svg>
              ) : (
                ICON[a]
              )}
            </span>
            {saved ? "Saved" : LABEL[a]}
          </button>
        );
      })}
    </div>
  );
}
