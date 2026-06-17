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
