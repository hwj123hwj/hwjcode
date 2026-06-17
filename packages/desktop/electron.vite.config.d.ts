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
declare const _default: import("electron-vite").ElectronViteConfig;
export default _default;
