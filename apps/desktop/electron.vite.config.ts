import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Everything the main/preload bundles need at runtime is BUNDLED by vite —
// @render/* workspace packages (raw TS entrypoints) and `ws` alike — so `out/`
// is fully self-contained and electron-builder ships no node_modules (the
// packaged asar is just out/** + examples/**). Only electron and node builtins
// stay external. Keep this list in sync with the deps in package.json.
const bundleWorkspace = {
  exclude: [
    '@render/protocol',
    '@render/cdp-human-hand',
    '@render/sandbox',
    '@render/agent-bridge',
    '@render/opencli-router',
    '@render/opencli-bridge',
    '@render/ux-render',
    'ws',
  ],
};

const r = (p: string): string => resolve(__dirname, p);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    // Bundled ws MUST take its pure-JS path: vite stubs the optional native
    // deps (bufferutil/utf-8-validate) as EMPTY OBJECTS, so ws's guarded
    // `require('bufferutil')` "succeeds" and installs native-fastpath wrappers
    // that crash on any frame ≥48 bytes (`bufferUtil.mask is not a function`).
    // These defines make ws skip the native path entirely.
    define: {
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
      'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    },
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
