// The catalog IS the security boundary. The renderer can ONLY instantiate the
// shadcn components listed here and ONLY dispatch the actions declared here, so
// an adversarial LLM-authored UxMessage spec is structurally unable to inject
// anything outside this whitelist (render-architecture §8, "structure is the
// injection boundary"). Lifted from opencli-ux/ux-app/src/catalog.ts and
// extended with `login_done` for the Plane-2 human-hand auth journey.
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";
import type { UxResult } from "@render/protocol";

// The four action names the catalog whitelists. Kept as local literals (the
// panel imports @render/protocol for types only); the `satisfies` check below
// pins them to the protocol's UxResult["action"] union so they can never drift.
export const UX_ACTIONS = {
  submit: "ux_submit",
  confirm: "ux_confirm",
  cancel: "ux_cancel",
  loginDone: "login_done",
} as const satisfies Record<string, UxResult["action"]>;

export const uxCatalog = defineCatalog(schema, {
  components: {
    ...shadcnComponentDefinitions,
  },
  actions: {
    [UX_ACTIONS.submit]: {
      params: z.object({}).passthrough(),
      description: "Submit the form — current state is returned as values",
    },
    [UX_ACTIONS.confirm]: {
      params: z.object({ choice: z.string().optional() }).passthrough(),
      description: "Confirm a choice — returns the picked option",
    },
    [UX_ACTIONS.cancel]: {
      params: z.object({}).passthrough(),
      description: "Cancel / dismiss without resolving values",
    },
    [UX_ACTIONS.loginDone]: {
      params: z.object({ account: z.string().optional() }).passthrough(),
      description: "Signal the human-hand login journey finished",
    },
  },
});
