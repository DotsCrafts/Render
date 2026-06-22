// Catches render errors from an agent-authored dynamic json-render spec and
// shows a fallback (prose) instead of breaking the whole panel. Generative UIs
// are powerful but the model can emit an invalid spec — degrade gracefully.
import { Component, type ReactNode } from "react";

interface Props {
  fallback: ReactNode;
  children: ReactNode;
}

export class SpecErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  // swallow — the fallback is the user-visible signal; no console noise
  componentDidCatch(): void {}

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
