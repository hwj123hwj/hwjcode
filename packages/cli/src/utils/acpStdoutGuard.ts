/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Side-effect module: reserve stdout for the ACP JSON-RPC protocol.
 *
 * In ACP mode stdout is a JSON-RPC wire — ANY stray text corrupts the frames.
 * The tricky part is timing: several modules log at *import* time (most notably
 * core's `proxyAuthManager` singleton, which prints "[Login Check] ..." from its
 * constructor). ESM hoists `import` statements, so a redirect performed inside
 * `main()` runs *after* the whole dependency graph — including those singletons —
 * has already been evaluated and has already written to stdout.
 *
 * Importing THIS module before `./src/gemini.js` in the entry point guarantees
 * the console is repointed to stderr before the rest of the graph loads. Its only
 * import is the (logging-free) `silentMode` module, whose `originalConsole`
 * capture runs first and grabs the real console methods, after which we redirect
 * both the live `console.*` and those captured references to stderr.
 *
 * NOTE: that ESM import-order guarantee only holds for the source/dev path. In
 * the esbuild bundle the ordering is reversed — deeply-shared deps (core's
 * `proxyAuthManager` singleton) are emitted near the top while this entry-only
 * module lands near the bottom, so the singleton's import-time logging escapes
 * to stdout before this redirect runs. The bundle therefore reserves stdout even
 * earlier, in the esbuild `banner` (see esbuild.config.js). This module remains
 * the guard for unbundled runs.
 *
 * argv isn't parsed this early, so we sniff the raw process arguments.
 */
import { redirectConsoleToStderr } from './silentMode.js';

/** True when the process was launched with `--acp` / `--experimental-acp`. */
export const isAcpMode = process.argv.some(
  (a) =>
    a === '--acp' ||
    a === '--experimental-acp' ||
    a.startsWith('--acp=') ||
    a.startsWith('--experimental-acp='),
);

if (isAcpMode) {
  redirectConsoleToStderr();
}
