import type { ReactElement } from 'react';
import type { AgentEvent, UxResult } from '@render/protocol';
import { AgentPanel as UxAgentPanel } from '@render/ux-render';

interface Props {
  events: AgentEvent[];
  onResolve: (id: string, result: UxResult) => void;
}

/**
 * The right-side agent panel. This is the REAL @render/ux-render panel (Worker
 * C's @json-render/shadcn surfaces), fed by the IPC AgentEvent stream and wired
 * so blocking confirm/form/login surfaces resolve back through `resolveUx`.
 *
 * It lives in the `.panel` grid area (see styles.css); the ux-render panel fills
 * it (`h-full`) and paints its own catalog-whitelisted dark theme.
 */
export function AgentPanel({ events, onResolve }: Props): ReactElement {
  return (
    <aside className="panel">
      <UxAgentPanel events={events} onResolve={onResolve} title="Agent" />
    </aside>
  );
}
