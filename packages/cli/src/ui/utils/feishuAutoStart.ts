/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decide whether the `--feishu` auto-start **polling fallback** should run.
 *
 * Background: `easycode --feishu` boots the interactive Ink app and relies on a
 * state-driven `useEffect` to issue `/feishu start`. When the process has no TTY
 * (e.g. the desktop app spawns it with stdio piped), Ink degrades its render and
 * those effect dependencies may never update, so `/feishu start` is never sent —
 * the process stays alive but the gateway never actually connects.
 *
 * A polling fallback exists for exactly this no-TTY case. It must be enabled when
 * either:
 *   - `EASYCODE_STARTUP_DELAY_MS` is set — the self-update relaunch helper sets
 *     this on the restarted, detached process; or
 *   - `EASYCODE_DESKTOP_MANAGED === '1'` — the Electron desktop app sets this on
 *     the `--feishu` child it spawns (stdio piped, no TTY).
 *
 * The old guard checked only `EASYCODE_STARTUP_DELAY_MS`, so the desktop-spawned
 * gateway (which sets only `EASYCODE_DESKTOP_MANAGED`) silently skipped the
 * fallback and never started.
 */
export function shouldEnableFeishuAutoStartFallback(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.EASYCODE_DESKTOP_MANAGED === '1') return true;
  if (env.EASYCODE_STARTUP_DELAY_MS) return true;
  return false;
}
