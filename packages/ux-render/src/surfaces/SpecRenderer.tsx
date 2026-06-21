// Thin wrapper around the json-render runtime. Every form/confirm surface uses
// this with its OWN handlers + onStateChange so concurrent surfaces stay
// isolated. The shared (stateless) component registry is the only global.
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { Spec } from "@json-render/core";
import { registry } from "../registry";
import type { StateChange } from "../stateMirror";

export type ActionHandlers = Record<
  string,
  (params: Record<string, unknown>) => void | Promise<void>
>;

export function SpecRenderer({
  spec,
  handlers,
  onStateChange,
}: {
  spec: Spec;
  handlers: ActionHandlers;
  onStateChange?: (changes: StateChange[]) => void;
}) {
  return (
    <JSONUIProvider
      registry={registry}
      initialState={spec.state ?? {}}
      handlers={handlers}
      onStateChange={onStateChange}
    >
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}
