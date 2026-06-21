// `login` — external (Plane-2) auth via the human-hand CDP tab. This surface is
// bespoke (not an LLM-authored spec): the fields are host-supplied, so it's
// rendered directly with themed Tailwind rather than lowered through the catalog.
//
// States: idle (prompt + "Log in") → connecting (the host has taken over a real
// Chromium tab; the human completes login there) → resolved (login_done). The
// host wires the actual CDP tab; here we render the prompt and the states and
// emit login_done when the journey completes. A real host may also resolve the
// message externally, which unmounts this surface mid-flight (timer cleared).
import { useEffect, useRef, useState } from "react";
import type { UxLoginResult, UxLoginSpec } from "@render/protocol";

type Phase = "idle" | "connecting";

// How long the simulated human-hand journey takes before emitting login_done.
// Real embeddings resolve the message themselves; this keeps the panel demoable
// standalone and gives the "connecting" state something to show.
const JOURNEY_MS = 1600;

export function LoginSurface({
  spec,
  onResolve,
}: {
  spec: UxLoginSpec;
  onResolve: (result: UxLoginResult) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const begin = () => {
    setPhase("connecting");
    timer.current = setTimeout(() => {
      onResolve({ action: "login_done", loggedIn: true, account: spec.site });
    }, JOURNEY_MS);
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
        Your password and cookies never leave this device. Login happens on your
        own browser tab via the human-hand (CDP); the sandbox never sees Plane-2
        credentials.
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
            Opening a secure browser tab — complete the login there…
          </span>
        </div>
      )}
    </div>
  );
}
