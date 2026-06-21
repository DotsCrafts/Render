// Renders one UxMessage: picks the surface by kind, wraps it in a labelled
// shell, and swaps to a ResolvedNote once a blocking surface is resolved.
import type {
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
import { ResolvedNote } from "./surfaces/ResolvedNote";

const ACCENT: Record<UxKind, string> = {
  render: "border-l-emerald-500",
  form: "border-l-blue-500",
  confirm: "border-l-amber-500",
  login: "border-l-sky-500",
};

export function UxSurface({
  message,
  resolved,
  onResolve,
}: {
  message: UxMessage;
  resolved?: UxResult;
  onResolve: (result: UxResult) => void;
}) {
  const { kind, blocking } = message;
  const resolve = (r: UxResult) => {
    if (!resolved) onResolve(r);
  };

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
    }
  }

  return (
    <div className={`border-l-2 ${ACCENT[kind]} pl-3`}>
      <div className="flex items-center gap-2 mb-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="rounded border border-border px-1.5 py-0.5">ux {kind}</span>
        {blocking ? (
          <span className="rounded border border-amber-500/40 text-amber-500 px-1.5 py-0.5">
            {resolved ? "resolved" : "blocking"}
          </span>
        ) : null}
      </div>
      {inner}
    </div>
  );
}
