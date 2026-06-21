// Shown in place of a blocking surface once it has been resolved, so the human
// can't double-submit and the panel keeps a record of what was decided.
import type { UxKind, UxResult } from "@render/protocol";

function summarize(kind: UxKind, result: UxResult): string {
  switch (result.action) {
    case "ux_submit": {
      const n = result.values ? Object.keys(result.values).length : 0;
      return `Submitted ${n} field${n === 1 ? "" : "s"}`;
    }
    case "ux_confirm":
      return result.choice ? `Chose “${result.choice}”` : "Confirmed";
    case "ux_cancel":
      return kind === "form" ? "Form cancelled" : "Cancelled";
    case "login_done":
      return result.loggedIn
        ? `Logged in${result.account ? ` · ${result.account}` : ""}`
        : "Login cancelled";
    default:
      return "Resolved";
  }
}

export function ResolvedNote({
  kind,
  result,
}: {
  kind: UxKind;
  result: UxResult;
}) {
  const cancelled = result.action === "ux_cancel" || result.action === "login_cancel";
  return (
    <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm flex items-center gap-2">
      <span className={cancelled ? "text-muted-foreground" : "text-emerald-500"}>
        {cancelled ? "✕" : "✓"}
      </span>
      <span className="text-muted-foreground">{summarize(kind, result)}</span>
    </div>
  );
}
