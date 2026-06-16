import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' assert { type: 'json' };

/**
 * electron-vite config.
 *
 * - main:     Node process. `deepv-code-core` + `@agentclientprotocol/sdk` are
 *             kept external (they are heavy, partly native, and ship their own
 *             ESM) — `externalizeDepsPlugin` reads package.json deps and marks
 *             them external so they resolve from node_modules at runtime.
 * - preload:  thin contextBridge layer, also external-deps.
 * - renderer: a plain Vite + React SPA. No Node access; everything reaches the
 *             backend through the `window.easycode` bridge exposed by preload.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
    // Expose the app version (from package.json) to the renderer as a compile-
    // time constant, so the sidebar can show it without a Node/IPC round-trip.
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
