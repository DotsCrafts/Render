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

  const cancel = () => onResolve({ action: "login_cancel", loggedIn: false });

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-md"
          style={{ background: "var(--accent-2-tint)", color: "var(--accent-2)" }}
          aria-hidden
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="10" height="6.5" rx="1.4" />
            <path d="M5.2 7V5.2a2.8 2.8 0 015.6 0V7" />
          </svg>
        </span>
        <h3 className="text-base font-semibold" style={{ color: "var(--fg)" }}>
          Sign in to <span className="font-mono">{spec.site}</span>
        </h3>
      </div>

      {spec.reason ? (
        <p className="text-sm mb-3" style={{ color: "var(--fg-muted)" }}>
          {spec.reason}
        </p>
      ) : (
        <p className="text-sm mb-3" style={{ color: "var(--fg-muted)" }}>
          The agent needs your session on{" "}
          <span className="font-mono">{spec.site}</span> to continue.
        </p>
      )}

      {/* the trust moment — make the on-device guarantee unmissable */}
      <div
        className="flex gap-2 rounded-lg px-3 py-2 mb-4 text-xs"
        style={{ background: "var(--bg-inset)", color: "var(--fg-subtle)" }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--success)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0" aria-hidden>
          <path d="M8 1.8l5 2v3.3c0 3.2-2.1 5.4-5 6.6-2.9-1.2-5-3.4-5-6.6V3.8z" />
          <path d="M5.8 8.1l1.5 1.5 3-3.3" />
        </svg>
        <span>
          Your password &amp; cookies <strong style={{ color: "var(--fg-muted)" }}>never leave this device</strong>.
          Login happens in a Render browser tab and the session stays inside
          Render; the sandbox never sees these credentials.
          {spec.loginUrl ? (
            <span className="block mt-1 font-mono break-all text-[11px] opacity-80">
              {spec.loginUrl}
            </span>
          ) : null}
        </span>
      </div>

      {phase === "idle" ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={begin}
            className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium"
            style={{ background: "var(--brand)", color: "var(--fg-onBrand)" }}
          >
            {spec.loginUrl ? "Sign in" : "Open sign-in page"}
          </button>
          <button
            type="button"
            onClick={cancel}
            className="inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium"
            style={{ color: "var(--fg-muted)", background: "var(--bg-overlay)" }}
          >
            Not now
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-sm" style={{ color: "var(--fg-muted)" }}>
          <span
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
          <span>
            Opening the sign-in page in Render — complete the login there, then
            ask me to retry.
          </span>
        </div>
      )}
    </div>
  );
}
