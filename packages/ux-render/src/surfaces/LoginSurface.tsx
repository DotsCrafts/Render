// `login` — external (Plane-2) auth via the human-hand CDP tab. This surface is
// bespoke (not an LLM-authored spec): the fields are host-supplied, so it's
// rendered directly with themed Tailwind rather than lowered through the catalog.
//
// States: idle (prompt + "Log in") → connecting (the host opens the site's login
// page in Render's OWN tab; the human completes login there). Pressing "Log in"
// signals the host to open the tab — it does NOT assert a session exists. The
// host emits its own honest follow-up ("opened login — retry when done"); this
// surface NEVER fabricates a "logged in" result.
import type { UxLoginResult, UxLoginSpec } from "@render/protocol";
import { useState } from "react";

type Phase = "idle" | "connecting";

export function LoginSurface({
  spec,
  onResolve,
}: {
  spec: UxLoginSpec;
  onResolve: (result: UxLoginResult) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");

  const begin = () => {
    setPhase("connecting");
    // Signal the host to open the login tab. loggedIn:false — we genuinely don't
    // know yet; the user logs in on the tab and then asks the agent to retry.
    onResolve({ action: "login_done", loggedIn: false, account: spec.site });
  };

  return (
    <div className="rounded-xl border border-border bg-card text-card-foreground p-5">
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-sky-500/15 text-sky-500 text-xs font-semibold">
          ↪
        </span>
        <h3 className="text-base font-semibold">
          Log in to <span className="font-mono">{spec.site}</span>
        </h3>
      </div>

      {spec.reason ? (
        <p className="text-sm text-muted-foreground mb-3">{spec.reason}</p>
      ) : (
        <p className="text-sm text-muted-foreground mb-3">
          The agent needs your session on{" "}
          <span className="font-mono">{spec.site}</span> to continue.
        </p>
      )}

      <div className="rounded-lg bg-muted/50 px-3 py-2 mb-4 text-xs text-muted-foreground">
        Your password and cookies never leave this device. Login happens in a
        Render browser tab and the session stays inside Render; the sandbox never
        sees Plane-2 credentials.
        {spec.loginUrl ? (
          <div className="mt-1 font-mono break-all text-[11px] opacity-80">
            {spec.loginUrl}
          </div>
        ) : null}
      </div>

      {phase === "idle" ? (
        <button
          type="button"
          onClick={begin}
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90"
        >
          Log in
        </button>
      ) : (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
          <span>
            Opening the login page in Render — complete the login there, then
            ask me to retry.
          </span>
        </div>
      )}
    </div>
  );
}
