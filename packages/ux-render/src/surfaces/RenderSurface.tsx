// `ux render` — non-blocking structured reply (title + safe prose + item cards).
// Pure display: no actions, nothing to resolve.
import { useMemo } from "react";
import type { UxRenderSpec } from "@render/protocol";
import { lowerRender } from "../toJsonRender";
import { SpecRenderer } from "./SpecRenderer";

const NO_OP = {};

export function RenderSurface({ spec }: { spec: UxRenderSpec }) {
  const jsonSpec = useMemo(() => lowerRender(spec), [spec]);
  return <SpecRenderer spec={jsonSpec} handlers={NO_OP} />;
}
