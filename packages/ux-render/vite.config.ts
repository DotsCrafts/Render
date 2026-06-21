import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev harness (dev/) is a standalone Vite app that drives <AgentPanel/>
// with a scripted AgentEvent stream. The panel itself (src/) is consumed at
// source by apps/desktop — no build step needed there.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
