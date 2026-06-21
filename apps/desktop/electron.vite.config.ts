import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// @render/* workspace packages publish raw TS (main field → src/*.ts), so they
// must be BUNDLED by vite, not externalized. `ws` and electron stay external.
const bundleWorkspace = { exclude: ['@render/protocol', '@render/cdp-human-hand'] };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: { '@render/protocol': resolve(__dirname, '../../packages/protocol/src/index.ts') },
    },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
