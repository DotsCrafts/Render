// A scripted AgentEvent stream for the dev harness. It exercises every kind:
// the non-ux feed (turn/sandbox/reasoning/item/command/delta/error) and all four
// ux surfaces — including the three verbatim opencli-ux example specs plus a
// login and a confirm-with-diff. The harness replays these with delays so the
// panel behaves like a live stream.
import type { AgentEvent } from "@render/protocol";
import renderExample from "./examples/render.json";
import formExample from "./examples/form.json";
import confirmExample from "./examples/confirm.json";

const ts = (n: number) => 1_700_000_000_000 + n * 1000;

const CONFIRM_DIFF = `--- a/src/server.ts
+++ b/src/server.ts
@@ -12,7 +12,9 @@ export function start() {
-  const port = 3000;
+  const port = Number(process.env.PORT ?? 8080);
+  // bind all interfaces for the sandbox relay
   app.listen(port, () => {
-    log("listening");
+    log(\`listening on \${port}\`);
   });`;

// Each scripted step carries a delay (ms after the previous step) so blocking
// surfaces appear after some streamed context, like a real turn.
export interface Step {
  after: number;
  event: AgentEvent;
}

export const SCRIPT: Step[] = [
  { after: 0, event: { kind: "turn_started", turnId: "t_001" } },
  { after: 400, event: { kind: "sandbox", status: "spawning", provider: "local-seatbelt" } },
  { after: 500, event: { kind: "sandbox", status: "ready", provider: "local-seatbelt" } },
  {
    after: 500,
    event: {
      kind: "item",
      phase: "completed",
      item: { id: "u1", type: "userMessage", text: "钱江世纪城附近有什么咖啡店？帮我整理一下并选几家收藏。" },
    },
  },
  {
    after: 700,
    event: { kind: "reasoning", itemId: "r1", text: "Routing dianping (logged-in site) to the human-hand over CDP; arxiv-style public reads would stay in the sandbox." },
  },
  {
    after: 800,
    event: {
      kind: "item",
      phase: "completed",
      item: {
        id: "c1",
        type: "commandExecution",
        command: "opencli dianping search --area 世纪城 --q 咖啡",
        exitCode: 0,
        stdout: "2 results · routed via human-hand CDP tab",
      },
    },
  },
  { after: 600, event: { kind: "delta", itemId: "a1", text: "Found a couple of well-rated spots nearby — here they are:" } },

  // ── ux render — the verbatim opencli-ux render.json example ────────────────
  {
    after: 500,
    event: {
      kind: "ux",
      message: {
        id: "ux_render_1",
        kind: "render",
        blocking: false,
        spec: renderExample,
        ts: ts(8),
      },
    },
  },

  // ── ux form — the verbatim opencli-ux form.json example (blocking) ─────────
  {
    after: 900,
    event: {
      kind: "ux",
      message: {
        id: "ux_form_1",
        kind: "form",
        blocking: true,
        spec: formExample,
        ts: ts(9),
      },
    },
  },

  // ── ux confirm — the verbatim opencli-ux confirm.json example (blocking) ───
  {
    after: 900,
    event: {
      kind: "ux",
      message: {
        id: "ux_confirm_1",
        kind: "confirm",
        blocking: true,
        spec: confirmExample,
        ts: ts(10),
      },
    },
  },

  // ── ux confirm — danger + unified diff detail (blocking) ───────────────────
  {
    after: 700,
    event: {
      kind: "ux",
      message: {
        id: "ux_confirm_2",
        kind: "confirm",
        blocking: true,
        spec: {
          message: "Apply this change to src/server.ts and restart the dev server?",
          options: ["Apply", "Reject"],
          danger: true,
          detail: CONFIRM_DIFF,
        },
        ts: ts(11),
      },
    },
  },

  // ── login — Plane-2 human-hand auth (blocking) ─────────────────────────────
  {
    after: 700,
    event: {
      kind: "ux",
      message: {
        id: "ux_login_1",
        kind: "login",
        blocking: true,
        spec: {
          site: "zhihu",
          reason: "I need your zhihu session to read the answers behind the login wall.",
          loginUrl: "https://www.zhihu.com/signin",
          successHint: "has cookie z_c0",
        },
        ts: ts(12),
      },
    },
  },

  // ── a richer ux render — title + safe prose body + image item ──────────────
  {
    after: 700,
    event: {
      kind: "ux",
      message: {
        id: "ux_render_2",
        kind: "render",
        blocking: false,
        spec: {
          title: "Summary",
          body: "Here's the shortlist with walking distance and average spend.\n\nProse is rendered **safely** — markdown-ish text is set as textContent, never innerHTML, so an adversarial spec can't inject markup.",
          items: [
            {
              title: "Seesaw Coffee",
              subtitle: "评分 4.7 · 步行5min",
              image: "https://picsum.photos/seed/seesaw/96",
              fields: { 区域: "世纪城", 人均: "¥45" },
              url: "https://www.dianping.com/",
            },
          ],
        },
        ts: ts(13),
      },
    },
  },

  { after: 600, event: { kind: "turn_completed", status: "completed", durationMs: 8421 } },
];
