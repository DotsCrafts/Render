// `ux confirm` — message + optional danger Alert + optional diff detail + option
// buttons. Blocking: each option dispatches ux_confirm with its choice.
import { useMemo } from "react";
import type { UxConfirmResult, UxConfirmSpec } from "@render/protocol";
import { lowerConfirm } from "../toJsonRender";
import { UX_ACTIONS } from "../catalog";
import { SpecRenderer, type ActionHandlers } from "./SpecRenderer";

export function ConfirmSurface({
  spec,
  onResolve,
}: {
  spec: UxConfirmSpec;
  onResolve: (result: UxConfirmResult) => void;
}) {
  const jsonSpec = useMemo(() => lowerConfirm(spec), [spec]);

  const handlers = useMemo<ActionHandlers>(
    () => ({
      [UX_ACTIONS.confirm]: (params) =>
        onResolve({
          action: "ux_confirm",
          choice: typeof params?.choice === "string" ? params.choice : undefined,
        }),
      [UX_ACTIONS.cancel]: () => onResolve({ action: "ux_cancel" }),
    }),
    [onResolve],
  );

  return <SpecRenderer spec={jsonSpec} handlers={handlers} />;
}
