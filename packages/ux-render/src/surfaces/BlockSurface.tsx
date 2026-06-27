// `ux block` — the agent is stuck / needs a decision. Renders the question with
// optional choice buttons (each → ux_confirm with its label) AND a free-text
// steer field (→ ux_instruct with the typed instruction). Choosing an option or
// sending a steer both feed back into the conversation; the parent UxSurface goes
// inert (ResolvedNote) afterwards so the human can't double-submit.
//
// The free-text value is read from this surface's own state mirror (json-render
// hands action handlers only `params`, never live state), exactly like FormSurface.
import { useMemo } from "react";
import type { UxBlockResult, UxBlockSpec } from "@render/protocol";
import { lowerBlock } from "../toJsonRender";
import { createMirror } from "../stateMirror";
import { UX_ACTIONS } from "../catalog";
import { SpecRenderer, type ActionHandlers } from "./SpecRenderer";

export function BlockSurface({
  spec,
  onResolve,
}: {
  spec: UxBlockSpec;
  onResolve: (result: UxBlockResult) => void;
}) {
  const jsonSpec = useMemo(() => lowerBlock(spec), [spec]);
  const mirror = useMemo(() => createMirror(jsonSpec.state), [jsonSpec]);

  const handlers = useMemo<ActionHandlers>(
    () => ({
      [UX_ACTIONS.confirm]: (params) =>
        onResolve({
          action: "ux_confirm",
          choice: typeof params?.choice === "string" ? params.choice : undefined,
        }),
      [UX_ACTIONS.instruct]: () => {
        const instruction = String(mirror.get().instruction ?? "").trim();
        if (!instruction) return; // empty steer is a no-op — keep the card live
        onResolve({ action: "ux_instruct", instruction });
      },
      [UX_ACTIONS.cancel]: () => onResolve({ action: "ux_cancel" }),
    }),
    [mirror, onResolve],
  );

  return (
    <SpecRenderer
      spec={jsonSpec}
      handlers={handlers}
      onStateChange={(changes) => mirror.apply(changes)}
    />
  );
}
