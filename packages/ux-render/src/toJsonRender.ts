// Lower a Render UxMessage spec (protocol/src/ux.ts) into a json-render Spec
// built ONLY from whitelisted shadcn components. Verbatim-compatible with the
// opencli-ux contract (so examples/*.json render unchanged) and extended for
// the protocol additions: render `body` prose and confirm `detail` diffs.
//
// Pure: every function returns a fresh Spec (and forms also return their
// FormMeta) so nothing is shared between concurrent surfaces.
import type { Spec } from "@json-render/core";
import type {
  UxConfirmSpec,
  UxFormField,
  UxFormSpec,
  UxRenderSpec,
} from "@render/protocol";
import { UX_ACTIONS } from "./catalog";

type El = NonNullable<Spec["elements"]>[string];

export interface FormMeta {
  fields: UxFormField[];
}

const MS_ROOT = "__ms"; // scratch state namespace for multiselect checkboxes

// Strip inline markdown emphasis markers (**bold**, *italic*, `code`) to plain
// text. This never produces HTML — json-render's Text sets textContent — so it
// keeps the "rendered safely" guarantee while reading cleanly instead of showing
// literal markers.
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}

// Split prose into paragraphs and render each as a safe Text node. json-render's
// Text sets textContent (never innerHTML), so markdown-ish body can't inject.
function proseElements(
  body: string,
  idPrefix: string,
): { elements: Record<string, El>; ids: string[] } {
  const elements: Record<string, El> = {};
  const ids: string[] = [];
  body
    .split(/\n{2,}/)
    .map((p) => stripMarkdown(p.trim()))
    .filter(Boolean)
    .forEach((para, i) => {
      const id = `${idPrefix}${i}`;
      elements[id] = { type: "Text", props: { text: para, variant: "default" } };
      ids.push(id);
    });
  return { elements, ids };
}

// ── render ───────────────────────────────────────────────────────────────────
export function lowerRender(s: UxRenderSpec): Spec {
  const elements: Record<string, El> = {};
  const rootChildren: string[] = [];

  if (s.title) {
    elements.title = {
      type: "Heading",
      props: { text: String(s.title), level: "h2" },
    };
    rootChildren.push("title");
  }

  if (s.body) {
    const { elements: bodyEls, ids } = proseElements(String(s.body), "body");
    Object.assign(elements, bodyEls);
    rootChildren.push(...ids);
  }

  const items = Array.isArray(s.items) ? s.items : [];
  items.forEach((it, i) => {
    const cardId = `item${i}`;
    const innerId = `item${i}_body`;
    const bodyChildren: string[] = [];

    if (it.image) {
      const id = `${innerId}_img`;
      elements[id] = {
        type: "Image",
        props: { src: String(it.image), alt: String(it.title ?? ""), width: 96, height: 96 },
      };
      bodyChildren.push(id);
    }
    const fields = it.fields ?? {};
    Object.entries(fields).forEach(([k, v], fi) => {
      const id = `${innerId}_f${fi}`;
      elements[id] = {
        type: "Text",
        props: { text: `${k}: ${v}`, variant: "muted" },
      };
      bodyChildren.push(id);
    });
    if (it.url) {
      const id = `${innerId}_link`;
      elements[id] = {
        type: "Link",
        props: { label: "Open", href: String(it.url) },
      };
      bodyChildren.push(id);
    }

    elements[innerId] = {
      type: "Stack",
      props: { direction: "vertical", gap: "sm" },
      children: bodyChildren,
    };
    elements[cardId] = {
      type: "Card",
      props: {
        title: String(it.title ?? ""),
        description: it.subtitle ? String(it.subtitle) : null,
        maxWidth: "full",
      },
      children: [innerId],
    };
    rootChildren.push(cardId);
  });

  elements.root = {
    type: "Stack",
    props: { direction: "vertical", gap: "md" },
    children: rootChildren,
  };
  return { root: "root", state: {}, elements };
}

// ── form ───────────────────────────────────────────────────────────────────
export function lowerForm(s: UxFormSpec): { spec: Spec; formMeta: FormMeta } {
  const rawFields = Array.isArray(s.fields) ? s.fields : [];
  const elements: Record<string, El> = {};
  const state: Record<string, unknown> = {};
  const formChildren: string[] = [];

  if (s.title) {
    elements.title = {
      type: "Heading",
      props: { text: String(s.title), level: "h3" },
    };
    formChildren.push("title");
  }

  rawFields.forEach((f, fi) => {
    const id = `field${fi}`;
    const type = f.type ?? "text";
    const label = f.label ?? f.name;

    if (type === "multiselect") {
      const groupChildren: string[] = [];
      const labelId = `${id}_label`;
      elements[labelId] = { type: "Text", props: { text: label, variant: "caption" } };
      groupChildren.push(labelId);

      (f.options ?? []).forEach((opt, oi) => {
        const cbId = `${id}_opt${oi}`;
        const path = `/${MS_ROOT}/${fi}/${oi}`;
        elements[cbId] = {
          type: "Checkbox",
          props: {
            label: opt,
            name: `${f.name}__${oi}`,
            checked: { $bindState: path } as never,
          },
        };
        groupChildren.push(cbId);
      });
      const msState = (state[MS_ROOT] ??= {}) as Record<string, unknown>;
      msState[String(fi)] = {};

      elements[id] = {
        type: "Stack",
        props: { direction: "vertical", gap: "sm" },
        children: groupChildren,
      };
      formChildren.push(id);
      return;
    }

    if (type === "select") {
      state[f.name] = f.value ?? "";
      elements[id] = {
        type: "Select",
        props: {
          label,
          name: f.name,
          options: f.options ?? [],
          placeholder: f.placeholder ?? "Select…",
          value: { $bindState: `/${f.name}` } as never,
          checks: null,
        },
      };
      formChildren.push(id);
      return;
    }

    if (type === "checkbox" || type === "switch") {
      state[f.name] = Boolean(f.value ?? false);
      elements[id] = {
        type: type === "checkbox" ? "Checkbox" : "Switch",
        props: { label, name: f.name, checked: { $bindState: `/${f.name}` } as never },
      };
      formChildren.push(id);
      return;
    }

    if (type === "textarea") {
      state[f.name] = f.value ?? "";
      elements[id] = {
        type: "Textarea",
        props: {
          label,
          name: f.name,
          placeholder: f.placeholder ?? null,
          rows: 4,
          value: { $bindState: `/${f.name}` } as never,
          checks: null,
        },
      };
      formChildren.push(id);
      return;
    }

    // text | email | password | number → Input
    state[f.name] = f.value ?? "";
    const inputType = ["email", "password", "number"].includes(type) ? type : "text";
    elements[id] = {
      type: "Input",
      props: {
        label,
        name: f.name,
        type: inputType,
        placeholder: f.placeholder ?? null,
        value: { $bindState: `/${f.name}` } as never,
        checks: null,
      },
    };
    formChildren.push(id);
  });

  elements.submitBtn = {
    type: "Button",
    props: { label: String(s.submitLabel ?? "Submit"), variant: "primary" },
    on: { press: { action: UX_ACTIONS.submit } },
  };
  elements.cancelBtn = {
    type: "Button",
    props: { label: "Cancel", variant: "secondary" },
    on: { press: { action: UX_ACTIONS.cancel } },
  };
  elements.actions = {
    type: "Stack",
    props: { direction: "horizontal", gap: "sm", justify: "end" },
    children: ["cancelBtn", "submitBtn"],
  };
  formChildren.push("actions");

  elements.form = {
    type: "Stack",
    props: { direction: "vertical", gap: "md" },
    children: formChildren,
  };
  elements.root = {
    type: "Card",
    props: { title: s.title ? null : "Form", description: null, maxWidth: "full" },
    children: ["form"],
  };
  return { spec: { root: "root", state, elements }, formMeta: { fields: rawFields } };
}

// ── confirm ──────────────────────────────────────────────────────────────────
export function lowerConfirm(s: UxConfirmSpec): Spec {
  const elements: Record<string, El> = {};
  const options =
    Array.isArray(s.options) && s.options.length ? s.options : ["允许", "拒绝"];

  elements.msg = {
    type: "Text",
    props: { text: String(s.message ?? "Confirm?"), variant: "lead" },
  };
  const bodyChildren = ["msg"];

  if (s.danger) {
    elements.danger = {
      type: "Alert",
      props: {
        title: "Sensitive action",
        message: "Please confirm you understand the impact of this operation.",
        type: "warning",
      },
    };
    bodyChildren.push("danger");
  }

  // Optional unified diff / detail, one safe Text line per row inside a Card so
  // multi-line content survives (Text would otherwise collapse whitespace).
  if (s.detail) {
    const lineIds: string[] = [];
    String(s.detail)
      .replace(/\n+$/, "")
      .split("\n")
      .forEach((line, i) => {
        const id = `diff${i}`;
        elements[id] = {
          type: "Text",
          props: { text: line === "" ? " " : line, variant: "caption" },
        };
        lineIds.push(id);
      });
    elements.diffBody = {
      type: "Stack",
      props: { direction: "vertical", gap: "none" },
      children: lineIds,
    };
    elements.diffCard = {
      type: "Card",
      props: { title: "Details", description: null, maxWidth: "full" },
      children: ["diffBody"],
    };
    bodyChildren.push("diffCard");
  }

  const btnIds: string[] = [];
  options.forEach((opt, i) => {
    const id = `opt${i}`;
    const danger = s.danger && i === 0;
    elements[id] = {
      type: "Button",
      props: { label: opt, variant: danger ? "destructive" : i === 0 ? "primary" : "secondary" },
      on: { press: { action: UX_ACTIONS.confirm, params: { choice: opt } } },
    };
    btnIds.push(id);
  });
  elements.actions = {
    type: "Stack",
    props: { direction: "horizontal", gap: "sm", justify: "end" },
    children: btnIds,
  };
  bodyChildren.push("actions");

  elements.body = {
    type: "Stack",
    props: { direction: "vertical", gap: "md" },
    children: bodyChildren,
  };
  elements.root = {
    type: "Card",
    props: { title: "Confirm", description: null, maxWidth: "full" },
    children: ["body"],
  };
  return { root: "root", state: {}, elements };
}

// ── value normalization ────────────────────────────────────────────────────
// json-render state for a lowered form is flat by field name, except
// multiselect lives under __ms/<fieldIndex>/<optIndex> as booleans. Shape it
// back into the clean {name: value} the agent seam expects.
export function normalizeFormValues(
  state: Record<string, unknown>,
  formMeta: FormMeta,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ms = (state[MS_ROOT] ?? {}) as Record<string, Record<string, unknown>>;

  formMeta.fields.forEach((f, fi) => {
    const type = f.type ?? "text";
    if (type === "multiselect") {
      const picks = ms[String(fi)] ?? {};
      out[f.name] = (f.options ?? []).filter((_, oi) => !!picks[String(oi)]);
      return;
    }
    const v = state[f.name];
    if (type === "number") {
      out[f.name] = v === "" || v == null ? null : Number(v);
      return;
    }
    out[f.name] = v ?? (type === "checkbox" || type === "switch" ? false : "");
  });
  return out;
}
