// In the JSONUIProvider + Renderer composition, action handlers receive only
// `params` — the live form state is NOT passed to them. JSONUIProvider exposes
// an `onStateChange` callback emitting incremental {path, value} changes, so we
// mirror those into a plain object and let ux_submit read the snapshot.
//
// Unlike opencli-ux (one global mirror), this is a FACTORY: each form surface
// owns its own mirror, so multiple concurrent surfaces never clobber each other.
import type { Spec } from "@json-render/core";

export interface StateChange {
  path: string;
  value: unknown;
}

export interface Mirror {
  get(): Record<string, unknown>;
  apply(changes: StateChange[]): void;
}

export function createMirror(initial: Spec["state"]): Mirror {
  // deep clone so we never mutate the spec's state
  let state: Record<string, unknown> = initial
    ? structuredClone(initial as Record<string, unknown>)
    : {};

  return {
    get: () => state,
    // Apply json-pointer-style changes ("/name", "/__ms/0/1") immutably,
    // creating intermediate objects as needed (RFC6901 segment unescaping).
    apply(changes) {
      let next = state;
      for (const { path, value } of changes) {
        const segments = path
          .split("/")
          .filter(Boolean)
          .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
        if (segments.length === 0) continue;
        next = setIn(next, segments, value);
      }
      state = next;
    },
  };
}

function setIn(
  node: Record<string, unknown>,
  segments: string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (head === undefined) return node;
  if (rest.length === 0) {
    return { ...node, [head]: value };
  }
  const child =
    typeof node[head] === "object" && node[head] !== null
      ? (node[head] as Record<string, unknown>)
      : {};
  return { ...node, [head]: setIn(child, rest, value) };
}
