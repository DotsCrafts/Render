// @render/ux-render — embeddable agent panel for the Render browser.
//
// Consumers (apps/desktop) import the panel and the stylesheet:
//   import { AgentPanel } from "@render/ux-render";
//   import "@render/ux-render/styles.css";
//
// The panel renders the four Render UX message types behind a catalog
// whitelist; structure is the injection boundary (see catalog.ts).
export { AgentPanel } from "./AgentPanel";
export type { AgentPanelProps } from "./AgentPanel";
export { UxSurface } from "./UxSurface";
export type { ResultAction } from "./surfaces/ResultActions";
export { uxCatalog, UX_ACTIONS } from "./catalog";
export { registry } from "./registry";
