/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fix the PATH for GUI launches on macOS/Linux.
 *
 * When the desktop app is started from Finder/Dock/Launchpad (macOS) or a
 * desktop launcher (Linux), the process does NOT go through a login shell, so
 * it inherits only a minimal PATH (typically `/usr/bin:/bin:/usr/sbin:/sbin`).
 * That omits `/usr/local/bin`, `/opt/homebrew/bin`, nvm/volta shims, etc. —
 * exactly where `claude`, `codex`, `node` and `npx` usually live. As a result
 * `detectExternalAgents()` (and later `npx` bridge spawns) fail even though the
 * tools are installed and visible in a terminal.
 *
 * We fix this once at startup by asking the user's login shell for its real
 * PATH and merging the missing dirs into `process.env.PATH`. This benefits both
 * the cc/codex detection AND the actual session spawn (npx bridge resolution).
 *
 * Windows is unaffected: GUI launches there inherit the full system/user PATH
 * from the registry, so this module is a no-op on win32.
 */

import { execFileSync } from 'node:child_process';

/**
 * Sentinel wrapped around the printed PATH so we can extract it reliably even
 * if the login shell emits banners/MOTD/noise on stdout.
 */
export const PATH_MARKER = '__EASYCODE_PATH__';

/** Options for {@link ensurePathFromLoginShell}, all injectable for testing. */
export interface EnsurePathOptions {
  platform: NodeJS.Platform;
  env: { PATH?: string };
  /** Returns the raw login-shell stdout, or null if the probe failed. */
  runLoginShell: () => string | null;
}

/**
 * Merge `extra`'s directories into `base`, preserving `base` order first and
 * appending only dirs not already present. Empty segments are dropped. Pure.
 */
export function mergePaths(base: string, extra: string, sep: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (chunk: string): void => {
    for (const dir of chunk.split(sep)) {
      const d = dir.trim();
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
  };
  add(base);
  add(extra);
  return out.join(sep);
}

/**
 * Pull the PATH value wrapped between two {@link PATH_MARKER} occurrences out of
 * raw shell stdout. Returns null if the marker is missing or the value is empty.
 * Pure.
 */
export function parseShellPath(stdout: string, marker: string): string | null {
  const first = stdout.indexOf(marker);
  if (first < 0) return null;
  const start = first + marker.length;
  const end = stdout.indexOf(marker, start);
  if (end < 0) return null;
  const value = stdout.slice(start, end).trim();
  return value.length > 0 ? value : null;
}

/**
 * Default login-shell probe: run the user's `$SHELL` as an interactive login
 * shell and print its PATH wrapped in markers. `-l` sources login profiles
 * (.zprofile/.bash_profile), `-i` sources interactive rc files (.zshrc/.bashrc)
 * where many users (and nvm) set PATH. Short timeout so a misbehaving rc can't
 * stall app startup; any failure resolves to null (caller keeps current PATH).
 */
function defaultRunLoginShell(env: { SHELL?: string }): string | null {
  const shell = env.SHELL || '/bin/sh';
  try {
    const out = execFileSync(
      shell,
      ['-lic', `printf '%s%s%s' '${PATH_MARKER}' "$PATH" '${PATH_MARKER}'`],
      { encoding: 'utf8', timeout: 3000 },
    );
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Repair `process.env.PATH` from the login shell on macOS/Linux GUI launches.
 * No-op on Windows. Returns true if PATH was actually changed.
 *
 * Mutates the passed `env` object in place (defaults to `process.env`).
 */
export function ensurePathFromLoginShell(
  opts?: Partial<EnsurePathOptions>,
): boolean {
  const platform = opts?.platform ?? process.platform;
  if (platform === 'win32') return false;

  const env = opts?.env ?? (process.env as { PATH?: string; SHELL?: string });
  const runLoginShell =
    opts?.runLoginShell ??
    (() => defaultRunLoginShell(env as { SHELL?: string }));

  const stdout = runLoginShell();
  if (!stdout) return false;

  const shellPath = parseShellPath(stdout, PATH_MARKER);
  if (!shellPath) return false;

  const current = env.PATH ?? '';
  const merged = mergePaths(current, shellPath, ':');
  if (merged === current) return false;

  env.PATH = merged;
  return true;
}

// ── Full environment capture (not just PATH) ──────────────────────────

/**
 * Sentinel wrapped around the printed env so we can extract it reliably even
 * if the login shell emits banners/MOTD/noise on stdout.
 */
export const ENV_MARKER = '__EASYCODE_ENV_START__';
export const ENV_MARKER_END = '__EASYCODE_ENV_END__';

/**
 * Parse `key=value` lines from the shell `env` output captured between markers.
 * Returns a map of env vars, or null if markers are missing.
 * Skips vars whose names are in `exclude` to avoid clobbering Electron-internal
 * vars or causing side effects.
 * Pure.
 */
export function parseShellEnv(
  stdout: string,
  startMarker: string,
  endMarker: string,
  exclude: Set<string>,
): Map<string, string> | null {
  const start = stdout.indexOf(startMarker);
  if (start < 0) return null;
  const end = stdout.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return null;
  const block = stdout.slice(start + startMarker.length, end).trim();
  if (!block) return new Map();

  const result = new Map<string, string>();
  for (const line of block.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || exclude.has(key)) continue;
    const value = line.slice(eq + 1);
    result.set(key, value);
  }
  return result.size > 0 ? result : null;
}

/**
 * Default full-env probe: run the user's `$SHELL` as an interactive login
 * shell (`-lic`) to source .zshrc/.bashrc etc., then print `env` wrapped in
 * markers. We use the same `-lic` flags as the PATH probe so users with
 * environment setup in their rc files (nvm, pyenv, API keys, etc.) get
 * captured. Short timeout (4s) so a broken rc can't stall app startup.
 */
function defaultRunLoginShellFullEnv(shell: string): string | null {
  try {
    const out = execFileSync(
      shell,
      [
        '-lic',
        // Use `env` output to capture ALL vars, not just PATH.
        // The markers let us extract even if there's MOTD/banner noise.
        `printf '${ENV_MARKER}\\n'; env; printf '${ENV_MARKER_END}\\n'`,
      ],
      { encoding: 'utf8', timeout: 4000 },
    );
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Repair `process.env` from the login shell on macOS/Linux GUI launches.
 * No-op on Windows.
 *
 * When the desktop app is started from Finder/Dock (macOS) or a desktop
 * launcher (Linux), the process inherits only a minimal environment — missing
 * PATH additions from .zshrc/.bashrc, and crucially any user-configured
 * environment variables like API keys, tool paths, etc. This makes the
 * spawned `easycode --acp` backend (and any child processes) blind to those
 * vars, breaking MCP tool auth, external agent detection, and more.
 *
 * This function captures the FULL login-shell environment (all vars) and
 * merges them into `process.env`, so the Electron process and all its spawned
 * children behave identically to a terminal-launched session.
 *
 * Key design decisions:
 * - Runs once at startup (expensive shell invocation).
 * - Timed out at 4s so a broken profile never hangs the app.
 * - Excludes vars that would break Electron (`_`, `SHLVL`, `PWD`, `OLDPWD`,
 *   `TERM_PROGRAM`, etc.) or leak state from the probe shell.
 * - Existing `process.env` values take priority (login-shell vars only fill
 *   gaps), so any env set by the OS or the .app bundle is preserved.
 * - Calls `ensurePathFromLoginShell` FIRST (which also runs the login shell),
 *   but the PATH probe is faster (3s timeout, single var). The full env probe
 *   only runs if the PATH probe succeeded (proves the shell is functional).
 */
export function ensureFullEnvFromLoginShell(opts?: {
  platform?: NodeJS.Platform;
  env?: { SHELL?: string } & Record<string, string | undefined>;
  runLoginShell?: () => string | null;
}): boolean {
  const platform = opts?.platform ?? process.platform;
  if (platform === 'win32') return false;

  const env = (opts?.env ?? process.env) as {
    SHELL?: string;
  } & Record<string, string | undefined>;
  const shell = env.SHELL || '/bin/sh';
  const runLoginShell =
    opts?.runLoginShell ?? (() => defaultRunLoginShellFullEnv(shell));

  const stdout = runLoginShell();
  if (!stdout) {
    console.warn('[shellPath] Full-env probe failed — keeping current environment');
    return false;
  }

  // Vars we must NOT overwrite from the login shell, because they would break
  // Electron or leak probe-shell state into the app process.
  const exclude = new Set([
    '_',           // Last-command tracking (shell internal)
    'SHLVL',       // Shell nesting level
    'PWD',         // Working directory of the probe, not the app
    'OLDPWD',      // Previous directory
    'TERM_PROGRAM',// Term-specific (e.g. Apple_Terminal)
    'TERM',        // Terminal type
    'LINES',       // Terminal dimensions
    'COLUMNS',
    'TERM_SESSION_ID',
    'ITERM_SESSION_ID',
    'XPC_SERVICE_NAME',
    'SECURITYSESSIONID',
    '__CFBundleIdentifier',
    'COMMAND_MODE',
    'TMPDIR',      // Protect system tmp — let Electron manage its own
    'HOME',        // Already set correctly by Electron
    'LOGNAME',
    'USER',
    'SHELL',       // Already set; probe shell might differ
    'DISPLAY',     // X11 — already set on Linux
    'WAYLAND_DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
  ]);

  const shellEnv = parseShellEnv(stdout, ENV_MARKER, ENV_MARKER_END, exclude);
  if (!shellEnv || shellEnv.size === 0) {
    console.warn('[shellPath] Full-env probe produced empty result');
    return false;
  }

  let mergedCount = 0;
  const targetEnv = (opts?.env ?? process.env) as Record<string, string | undefined>;
  for (const [key, value] of shellEnv) {
    if (targetEnv[key] !== undefined) continue; // existing value takes priority
    targetEnv[key] = value;
    mergedCount++;
  }

  console.log(
    `[shellPath] Merged ${mergedCount} env vars from login shell ` +
    `(${shellEnv.size} total captured, already-set values kept as-is)`,
  );
  return mergedCount > 0;
}
