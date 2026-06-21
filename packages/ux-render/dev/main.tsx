import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { DevHarness } from "./DevHarness";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("dev harness: #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <DevHarness />
  </StrictMode>,
);
