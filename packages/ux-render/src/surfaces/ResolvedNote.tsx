// Shown in place of a blocking surface once it has been resolved, so the human
// can't double-submit and the panel keeps a record of what was decided.
//
// `result` may also be the literal "replayed": the host replayed a resolution
// id after a renderer reload but the original UxResult is gone — the card
// renders inert with a neutral note instead of re-arming.
import type { UxKind, UxResult } from "@render/protocol";

function summarize(kind: UxKind, result: UxResult): string {
  switch (result.action) {
    case "ux_submit": {
      const n = result.values ? Object.keys(result.values).length : 0;
      return `Submitted ${n} field${n === 1 ? "" : "s"}`;
    }
    case "ux_confirm":
      return result.choice ? `Chose “${result.choice}”` : "Confirmed";
    case "ux_instruct": {
      const note = (result.instruction ?? "").trim();
      const short = note.length > 60 ? `${note.slice(0, 60)}…` : note;
      return short ? `Steered · “${short}”` : "Sent instruction";
    }
    case "ux_cancel":
      return kind === "form" ? "Form cancelled" : "Cancelled";
    case "login_done":
      // loggedIn:false is the honest "Sign in" click: the host opened the login
      // page but no session can be asserted yet — this is NOT a cancellation.
      return result.loggedIn
        ? `Logged in${result.account ? ` · ${result.account}` : ""}`
        : "Sign-in page opened — finish there, then ask me to retry";
    case "login_cancel":
      return "Login cancelled";
    default:
      return "Resolved";
  }
}

export function ResolvedNote({
  kind,
  result,
}: {
  kind: UxKind;
  result: UxResult | "replayed";
}) {
  if (result === "replayed") {
    return (
      <div className="text-sm flex items-center gap-2" style={{ color: "var(--fg-muted)" }}>
        <span style={{ color: "var(--fg-subtle)" }}>✓</span>
        <span>Resolved earlier</span>
      </div>
    );
  }
  const cancelled = result.action === "ux_cancel" || result.action === "login_cancel";
  // sign-in opened (login_done without a session yet) — in flight, not success
  const opened = result.action === "login_done" && !result.loggedIn;
  return (
    <div className="text-sm flex items-center gap-2" style={{ color: "var(--fg-muted)" }}>
      <span
        style={{
          color: cancelled
            ? "var(--fg-subtle)"
            : opened
              ? "var(--fg-muted)"
              : "var(--success)",
        }}
      >
        {cancelled ? "✕" : opened ? "→" : "✓"}
      </span>
      <span>{summarize(kind, result)}</span>
    </div>
  );
}
