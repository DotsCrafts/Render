// Renders one UxMessage: picks the surface by kind, wraps it in the shared
// card shell with a per-kind accent rail + a quiet kind header, and swaps to a
// ResolvedNote once a blocking surface is resolved. The card elevation + rail
// colors are token-driven (see .rd-surface in styles.css).
import type {
  UxBlockSpec,
  UxConfirmSpec,
  UxFormSpec,
  UxKind,
  UxLoginSpec,
  UxMessage,
  UxRenderSpec,
  UxResult,
} from "@render/protocol";
import { RenderSurface } from "./surfaces/RenderSurface";
import { FormSurface } from "./surfaces/FormSurface";
import { ConfirmSurface } from "./surfaces/ConfirmSurface";
import { LoginSurface } from "./surfaces/LoginSurface";
import { BlockSurface } from "./surfaces/BlockSurface";
import { ResolvedNote } from "./surfaces/ResolvedNote";
import { ResultActions, type ResultAction } from "./surfaces/ResultActions";

const LABEL: Record<UxKind, string> = {
  render: "Result",
  form: "Form",
  confirm: "Confirm",
  login: "Sign in",
  block: "Needs a decision",
};

export function UxSurface({
  message,
  resolved,
  onResolve,
  onAction,
}: {
  message: UxMessage;
  resolved?: UxResult;
  onResolve: (result: UxResult) => void;
  /** Delta 2: a next-step action fired from a result card's quiet row. */
  onAction?: (action: ResultAction, message: UxMessage) => void;
}) {
  const { kind, blocking } = message;
  const resolve = (r: UxResult) => {
    if (!resolved) onResolve(r);
  };
  const danger =
    (kind === "confirm" && !!(message.spec as UxConfirmSpec)?.danger) ||
    (kind === "block" && !!(message.spec as UxBlockSpec)?.danger);

  let inner: React.ReactNode;
  if (resolved) {
    inner = <ResolvedNote kind={kind} result={resolved} />;
  } else {
    switch (kind) {
      case "render":
        inner = <RenderSurface spec={message.spec as UxRenderSpec} />;
        break;
      case "form":
        inner = <FormSurface spec={message.spec as UxFormSpec} onResolve={resolve} />;
        break;
      case "confirm":
        inner = (
          <ConfirmSurface spec={message.spec as UxConfirmSpec} onResolve={resolve} />
        );
        break;
      case "login":
        inner = <LoginSurface spec={message.spec as UxLoginSpec} onResolve={resolve} />;
        break;
      case "block":
        inner = <BlockSurface spec={message.spec as UxBlockSpec} onResolve={resolve} />;
        break;
    }
  }

  // Delta 2: result cards (non-blocking `render`) get a quiet next-step row.
  const showActions = !resolved && !blocking && kind === "render" && !!onAction;

  return (
    <div className={`rd-surface ${kind}${danger ? " danger" : ""}`}>
      <div className="rd-surface-head">
        <span className="rd-surface-kind">
          <span className="dot" aria-hidden />
          {LABEL[kind]}
        </span>
        {blocking ? (
          <span className={`rd-pill-blocking${resolved ? " resolved" : ""}`}>
            {resolved ? "resolved" : "action needed"}
          </span>
        ) : null}
      </div>
      <div className="rd-surface-body">{inner}</div>
      {showActions ? (
        <ResultActions message={message} onAction={onAction!} />
      ) : null}
    </div>
  );
}
