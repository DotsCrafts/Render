// Standalone dev harness: replays the scripted AgentEvent stream into a docked
// <AgentPanel/>, mimicking how apps/desktop embeds it as the right-side stream.
// Controls let you replay, reveal everything at once (for screenshots), and flip
// the theme. onResolve is logged so blocking round-trips are observable.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, UxResult } from "@render/protocol";
import { AgentPanel } from "../src";
import { SCRIPT } from "./script";

const FULL_STREAM: AgentEvent[] = SCRIPT.map((s) => s.event);

type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function DevHarness() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [theme, setTheme] = useState<Theme>(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [log, setLog] = useState<string[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => applyTheme(theme), [theme]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const play = useCallback(() => {
    clearTimers();
    setEvents([]);
    setLog([]);
    let elapsed = 0;
    SCRIPT.forEach((step) => {
      elapsed += step.after;
      timers.current.push(
        setTimeout(() => setEvents((prev) => [...prev, step.event]), elapsed),
      );
    });
  }, []);

  useEffect(() => {
    play();
    return clearTimers;
  }, [play]);

  const revealAll = () => {
    clearTimers();
    setEvents(FULL_STREAM);
  };

  const onResolve = (id: string, result: UxResult) => {
    setLog((prev) => [...prev, `${id} → ${JSON.stringify(result)}`]);
  };

  return (
    <div className="flex h-screen flex-col bg-muted/30 text-foreground">
      <header className="flex items-center gap-2 border-b border-border bg-background px-4 py-2">
        <strong className="text-sm">Render</strong>
        <span className="font-mono text-[11px] text-muted-foreground">
          ux-render · dev harness
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={play}
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
          >
            ▶ Replay
          </button>
          <button
            type="button"
            onClick={revealAll}
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
          >
            ⤓ Reveal all
          </button>
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
          >
            {theme === "dark" ? "☾ Dark" : "☀ Light"}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Faux web-page area — stands in for the WebContentsView tabs. */}
        <main className="hidden flex-1 flex-col items-center justify-center gap-3 p-8 md:flex">
          <div className="text-center text-muted-foreground">
            <div className="text-5xl">🌐</div>
            <p className="mt-3 max-w-sm text-sm">
              The page area (real Chromium tabs in the desktop app). The agent
              panel on the right is what this package renders.
            </p>
          </div>
          {log.length > 0 ? (
            <div className="mt-4 w-full max-w-md rounded-lg border border-border bg-background p-3">
              <div className="mb-1 font-mono text-[10px] uppercase text-muted-foreground">
                onResolve log
              </div>
              <ul className="space-y-1 font-mono text-[11px] text-foreground/80">
                {log.map((line, i) => (
                  <li key={i} className="break-all">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </main>

        {/* The embedded agent panel. */}
        <aside className="flex w-full flex-col border-l border-border bg-background md:w-[440px]">
          <AgentPanel events={events} onResolve={onResolve} title="Agent" />
        </aside>
      </div>
    </div>
  );
}
