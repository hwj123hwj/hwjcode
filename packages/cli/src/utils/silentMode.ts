/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * Silent mode utilities for non-interactive CLI usage.
 * When enabled, suppresses all debug and informational output except errors.
 */

let isSilentMode = false;

// Store original console methods
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  debug: console.debug,
};

/**
 * Enables silent mode - suppresses all console output except errors
 */
export function enableSilentMode(): void {
  isSilentMode = true;
  
  // Override console methods to suppress output
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.debug = () => {};
}

/**
 * Disables silent mode - restores normal console output
 */
export function disableSilentMode(): void {
  isSilentMode = false;
  
  // Restore original console methods
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.debug = originalConsole.debug;
}

/**
 * Returns whether silent mode is currently enabled
 */
export function isSilentModeEnabled(): boolean {
  return isSilentMode;
}

/**
 * Redirect all informational console output to stderr.
 *
 * Unlike {@link enableSilentMode} (which drops the output entirely), this keeps
 * the logs visible — they just no longer touch stdout. This is required for ACP
 * mode, where stdout is a JSON-RPC wire and ANY stray text corrupts the frames,
 * but where we still want startup diagnostics ("[SessionManager] ...",
 * "🔄 Continuing last session...") available on stderr for debugging.
 *
 * Both the live `console.*` methods AND the `originalConsole` references are
 * repointed: `logIfNotSilent` calls the captured originals directly, so patching
 * only the global `console` would leave those CLI startup logs on stdout. The
 * global `console` patch additionally covers logs emitted from deep inside core
 * (which uses raw `console.log`), since `console` is a per-process singleton.
 *
 * Idempotent and intentionally not reversible — once stdout is reserved for the
 * protocol it must stay that way for the lifetime of the process.
 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: any[]): void => {
    try {
      const msg = args
        .map((a) =>
          typeof a === 'string'
            ? a
            : (() => {
                try {
                  return JSON.stringify(a);
                } catch {
                  return String(a);
                }
              })(),
        )
        .join(' ');
      process.stderr.write(`${msg}\n`);
    } catch {
      // A broken logger must never crash the runtime.
    }
  };

  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;

  // Keep `logIfNotSilent` (which uses the captured originals) on stderr too.
  originalConsole.log = toStderr;
  originalConsole.info = toStderr;
  originalConsole.warn = toStderr;
  originalConsole.debug = toStderr;
}

/**
 * Logs a message only if silent mode is disabled
 * Use this for optional informational messages
 */
export function logIfNotSilent(level: 'log' | 'info' | 'warn' | 'debug', ...args: any[]): void {
  if (!isSilentMode) {
    originalConsole[level](...args);
  }
}

/**
 * Always logs an error message regardless of silent mode
 * Errors are always shown as they indicate problems
 */
export function logError(...args: any[]): void {
  console.error(...args);
}