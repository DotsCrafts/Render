// `ux render` — non-blocking structured reply.
//
// Two modes:
//   • DYNAMIC: the agent supplied a full @json-render spec (spec.ui) → render it
//     through the catalog-guarded SpecRenderer, so the UI matches the content
//     (table / tabs / grid / badges / …). This is the generative path.
//   • SIMPLE: title + safe prose + item cards (lowered to a fixed layout).
// A render error in the dynamic path falls back to the simple/prose layout.
import { useMemo } from "react";
import type { Spec } from "@json-render/core";
import type { UxRenderSpec } from "@render/protocol";
import { lowerRender } from "../toJsonRender";
import { SpecRenderer } from "./SpecRenderer";
import { SpecErrorBoundary } from "./SpecErrorBoundary";

const NO_OP = {};

function isFullSpec(ui: unknown): ui is Spec {
  return (
    !!ui &&
    typeof ui === "object" &&
    typeof (ui as { root?: unknown }).root === "string" &&
    !!(ui as { elements?: unknown }).elements &&
    typeof (ui as { elements?: unknown }).elements === "object"
  );
}

export function RenderSurface({ spec }: { spec: UxRenderSpec }) {
  // the simple/prose layout doubles as the dynamic path's fallback
  const simple = useMemo(
    () => lowerRender({ title: spec.title, body: spec.body, items: spec.items }),
    [spec.title, spec.body, spec.items],
  );

  const content = isFullSpec(spec.ui) ? (
    <SpecErrorBoundary fallback={<SpecRenderer spec={simple} handlers={NO_OP} />}>
      <SpecRenderer spec={spec.ui} handlers={NO_OP} />
    </SpecErrorBoundary>
  ) : (
    <SpecRenderer spec={simple} handlers={NO_OP} />
  );
  // wide content (e.g. a big Table) scrolls horizontally instead of clipping
  return <div className="max-w-full overflow-x-auto">{content}</div>;
}
