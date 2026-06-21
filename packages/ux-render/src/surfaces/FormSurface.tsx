// `ux form` — inputs per field type. Blocking: Submit returns the live values,
// Cancel returns ux_cancel. The handler reads the live state from this surface's
// own mirror (json-render hands action handlers only `params`, not state).
import { useMemo } from "react";
import type { UxFormResult, UxFormSpec } from "@render/protocol";
import { lowerForm, normalizeFormValues } from "../toJsonRender";
import { createMirror } from "../stateMirror";
import { UX_ACTIONS } from "../catalog";
import { SpecRenderer, type ActionHandlers } from "./SpecRenderer";

export function FormSurface({
  spec,
  onResolve,
}: {
  spec: UxFormSpec;
  onResolve: (result: UxFormResult) => void;
}) {
  const { spec: jsonSpec, formMeta } = useMemo(() => lowerForm(spec), [spec]);
  const mirror = useMemo(() => createMirror(jsonSpec.state), [jsonSpec]);

  const handlers = useMemo<ActionHandlers>(
    () => ({
      [UX_ACTIONS.submit]: () =>
        onResolve({
          action: "ux_submit",
          values: normalizeFormValues(mirror.get(), formMeta),
        }),
      [UX_ACTIONS.cancel]: () => onResolve({ action: "ux_cancel" }),
    }),
    [mirror, formMeta, onResolve],
  );

  return (
    <SpecRenderer
      spec={jsonSpec}
      handlers={handlers}
      onStateChange={(changes) => mirror.apply(changes)}
    />
  );
}
