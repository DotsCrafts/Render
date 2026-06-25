import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// @render/* workspace packages publish raw TS (main field → src/*.ts), so they
// must be BUNDLED by vite, not externalized — otherwise electron-main would
// `require()` a .ts entrypoint at runtime and crash. `ws` / `e2b` / electron and
// node builtins stay external. Keep this list in sync with the @render/* deps in
// package.json (incl. transitive ones the main process pulls in).
const bundleWorkspace = {
  exclude: [
    '@render/protocol',
    '@render/cdp-human-hand',
    '@render/sandbox',
    '@render/agent-bridge',
    '@render/opencli-router',
    '@render/opencli-bridge',
    '@render/ux-render',
  ],
};

const r = (p: string): string => resolve(__dirname, p);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: { rollupOptions: { input: r('src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: {
      rollupOptions: {
        input: {
          // the single chrome-renderer preload.
          index: r('src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      // Source-alias the workspace packages the renderer bundles (raw TSX), and
      // dedupe React so the @json-render/shadcn surfaces share the app's copy.
      // Exact (`^…$`) matches so the bare specifier maps to src/index.ts while
      // the `/styles.css` subpath keeps resolving to its own file.
      dedupe: ['react', 'react-dom'],
      alias: [
        { find: /^@render\/protocol$/, replacement: r('../../packages/protocol/src/index.ts') },
        {
          find: '@render/ux-render/styles.css',
          replacement: r('../../packages/ux-render/src/styles.css'),
        },
        { find: /^@render\/ux-render$/, replacement: r('../../packages/ux-render/src/index.ts') },
      ],
    },
    build: {
      rollupOptions: { input: r('src/renderer/index.html') },
    },
  },
});
