// Component registry: binds catalog entries to the real shadcn components.
// Stateless and shared across every surface.
//
// The catalog declares actions, so defineRegistry requires an `actions` map —
// but the REAL handlers are supplied per-surface via JSONUIProvider's `handlers`
// prop (which is what actually executes), so each handler can close over that
// surface's id, live state, and onResolve callback (see surfaces/*). The actions
// here are inert defaults that are never reached in practice.
import { defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import { uxCatalog } from "./catalog";
import { UX_ACTIONS } from "./catalog";

const noop = async () => {};

export const { registry } = defineRegistry(uxCatalog, {
  components: {
    ...shadcnComponents,
  },
  actions: {
    [UX_ACTIONS.submit]: noop,
    [UX_ACTIONS.confirm]: noop,
    [UX_ACTIONS.cancel]: noop,
    [UX_ACTIONS.loginDone]: noop,
  },
});
