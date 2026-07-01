/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Open workspace with…" — detect locally-installed programs (editors, file
 * managers, terminals) and launch them on a session's working directory. Powers
 * the session-toolbar dropdown.
 *
 * Deliberately electron-free (only node builtins) so the catalog + command
 * building are unit-testable; the renderer never sees a raw command line, only
 * `{ id, name }`. Native icons are extracted separately in the IPC layer (which
 * has electron) from the `iconSource` path each resolved opener exposes.
 *
 * Detection is lazy: it runs on first `listOpeners()` (i.e. when the menu opens),
 * never at startup, and is cached in-process thereafter.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OpenerInfo } from '../shared/ipc.js';

type Platform = 'win32' | 'darwin' | 'linux';

/** Declarative launcher recipe for one program on one platform. */
interface OpenerRecipe {
  id: string;
  name: string;
  /** Executable/CLI probed via `where`/`which` (unless `alwaysAvailable`). */
  bin: string;
  /** Args placed after the resolved command to open `folder`. */
  buildArgs: (folder: string) => string[];
  /** Guaranteed system command — skip the probe, still resolve a path for its icon. */
  alwaysAvailable?: boolean;
  /** Extra existence gate (e.g. a macOS `.app` bundle) and default icon source. */
  appBundle?: string;
  /** Explicit icon-source path (defaults to appBundle, else the resolved bin). */
  iconPath?: string;
  /**
   * Windows: absolute `.exe` candidates (may contain `%ENV%`). Serve two roles:
   *  1. Detection/launch — GUI apps like Android Studio / IntelliJ / Sublime /
   *     Visual Studio aren't on PATH, so `where` finds nothing; if one of these
   *     candidates exists the program is considered installed and this real exe
   *     is what `start` launches.
   *  2. Icons — `app.getFileIcon` can't read a `.cmd`/shell-script shim, so it's
   *     pointed at the real executable instead.
   */
  winIconPaths?: string[];
  /**
   * Stem of a bundled PNG under `assets/icons/` (see `openerIcons.ts`) used as the
   * program's icon. Serves programs whose real exe is unreadable (e.g. `wt.exe`
   * under `WindowsApps`, where the user has no read permission) or as a fallback
   * when `app.getFileIcon` yields nothing.
   */
  bundledIcon?: string;
  /**
   * Skip `app.getFileIcon` entirely and always use {@link bundledIcon}. Set for
   * programs whose on-disk exe icon can't be extracted at all (Windows Terminal's
   * `WindowsApps` alias), so we don't risk a generic/blank system icon.
   */
  forceBundledIcon?: boolean;
  /**
   * Open the folder via Electron's `shell.openPath` instead of spawning — the
   * right way to reveal a directory in the OS file manager (Explorer / Finder /
   * default fm) on every platform.
   */
  shellOpen?: boolean;
}

/**
 * The per-platform catalog. Ids are stable — the renderer passes them back to
 * `openWith`. Ordered roughly file-manager → editors → terminals.
 */
export const PLATFORM_OPENERS: Record<Platform, OpenerRecipe[]> = {
  win32: [
    {
      id: 'explorer',
      name: 'File Explorer',
      bin: 'explorer.exe',
      alwaysAvailable: true,
      shellOpen: true,
      winIconPaths: ['%SystemRoot%\\explorer.exe'],
      buildArgs: (f) => [f],
    },
    {
      id: 'vscode',
      name: 'VS Code',
      bin: 'code',
      winIconPaths: [
        '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
        '%ProgramFiles%\\Microsoft VS Code\\Code.exe',
      ],
      buildArgs: (f) => [f],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      bin: 'cursor',
      winIconPaths: [
        '%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe',
        '%ProgramFiles%\\Cursor\\Cursor.exe',
      ],
      buildArgs: (f) => [f],
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      bin: 'windsurf',
      winIconPaths: [
        '%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe',
        '%ProgramFiles%\\Windsurf\\Windsurf.exe',
      ],
      buildArgs: (f) => [f],
    },
    {
      id: 'android-studio',
      name: 'Android Studio',
      bin: 'studio64.exe',
      winIconPaths: [
        '%ProgramFiles%\\Android\\Android Studio\\bin\\studio64.exe',
        '%LOCALAPPDATA%\\Programs\\Android Studio\\bin\\studio64.exe',
      ],
      buildArgs: (f) => [f],
    },
    {
      id: 'intellij',
      name: 'IntelliJ IDEA',
      bin: 'idea64.exe',
      winIconPaths: [
        '%ProgramFiles%\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe',
        '%ProgramFiles%\\JetBrains\\IntelliJ IDEA Community Edition\\bin\\idea64.exe',
        '%LOCALAPPDATA%\\Programs\\IntelliJ IDEA Ultimate\\bin\\idea64.exe',
        '%LOCALAPPDATA%\\Programs\\IntelliJ IDEA Community Edition\\bin\\idea64.exe',
      ],
      buildArgs: (f) => [f],
    },
    {
      id: 'sublime',
      name: 'Sublime Text',
      bin: 'sublime_text.exe',
      winIconPaths: [
        '%ProgramFiles%\\Sublime Text\\sublime_text.exe',
        '%ProgramFiles%\\Sublime Text 3\\sublime_text.exe',
      ],
      buildArgs: (f) => [f],
    },
    {
      id: 'visual-studio',
      name: 'Visual Studio',
      bin: 'devenv.exe',
      winIconPaths: [
        '%ProgramFiles%\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe',
        '%ProgramFiles%\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe',
        '%ProgramFiles%\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe',
      ],
      buildArgs: (f) => [f],
    },
    {
      id: 'wt',
      name: 'Windows Terminal',
      bin: 'wt.exe',
      // `wt.exe` is an app-execution alias under `WindowsApps` the user can't read,
      // so its icon can't be extracted — ship a bundled PNG and skip getFileIcon.
      bundledIcon: 'terminal',
      forceBundledIcon: true,
      buildArgs: (f) => ['-d', f],
    },
    {
      id: 'git-bash',
      name: 'Git Bash',
      bin: 'git-bash.exe',
      // Candidates still detect the install + provide the real exe to launch, but
      // `git-bash.exe` carries no extractable icon (a generic console glyph), so we
      // force the bundled Git PNG instead — same treatment as Windows Terminal.
      winIconPaths: [
        '%ProgramFiles%\\Git\\git-bash.exe',
        '%LOCALAPPDATA%\\Programs\\Git\\git-bash.exe',
      ],
      bundledIcon: 'git',
      forceBundledIcon: true,
      buildArgs: (f) => [`--cd=${f}`],
    },
    {
      id: 'wsl',
      name: 'WSL',
      bin: 'wsl.exe',
      // wsl.exe lives in System32 (on PATH) — detected via `where`, icon readable.
      buildArgs: (f) => ['--cd', f],
    },
    {
      id: 'powershell',
      name: 'PowerShell',
      bin: 'powershell.exe',
      alwaysAvailable: true,
      buildArgs: (f) => ['-NoExit', '-Command', `cd '${f}'`],
    },
    { id: 'cmd', name: 'CMD', bin: 'cmd.exe', alwaysAvailable: true, buildArgs: (f) => ['/K', `cd /d ${f}`] },
  ],
  darwin: [
    { id: 'finder', name: 'Finder', bin: 'open', alwaysAvailable: true, shellOpen: true, iconPath: '/System/Library/CoreServices/Finder.app', buildArgs: (f) => [f] },
    { id: 'vscode', name: 'VS Code', bin: 'code', buildArgs: (f) => [f] },
    { id: 'cursor', name: 'Cursor', bin: 'cursor', buildArgs: (f) => [f] },
    { id: 'windsurf', name: 'Windsurf', bin: 'windsurf', buildArgs: (f) => [f] },
    // GUI IDEs: detect via their `.app` bundle (their CLI shim isn't always on
    // PATH) and open the folder as a project through `open -a <AppName>`.
    { id: 'android-studio', name: 'Android Studio', bin: 'open', appBundle: '/Applications/Android Studio.app', buildArgs: (f) => ['-a', 'Android Studio', f] },
    { id: 'intellij', name: 'IntelliJ IDEA', bin: 'open', appBundle: '/Applications/IntelliJ IDEA.app', buildArgs: (f) => ['-a', 'IntelliJ IDEA', f] },
    { id: 'sublime', name: 'Sublime Text', bin: 'open', appBundle: '/Applications/Sublime Text.app', buildArgs: (f) => ['-a', 'Sublime Text', f] },
    { id: 'iterm', name: 'iTerm2', bin: 'open', appBundle: '/Applications/iTerm.app', buildArgs: (f) => ['-a', 'iTerm', f] },
    { id: 'terminal', name: 'Terminal', bin: 'open', alwaysAvailable: true, iconPath: '/System/Applications/Utilities/Terminal.app', buildArgs: (f) => ['-a', 'Terminal', f] },
  ],
  linux: [
    { id: 'file-manager', name: 'File Manager', bin: 'xdg-open', shellOpen: true, buildArgs: (f) => [f] },
    { id: 'vscode', name: 'VS Code', bin: 'code', buildArgs: (f) => [f] },
    { id: 'cursor', name: 'Cursor', bin: 'cursor', buildArgs: (f) => [f] },
    { id: 'android-studio', name: 'Android Studio', bin: 'studio', buildArgs: (f) => [f] },
    { id: 'intellij', name: 'IntelliJ IDEA', bin: 'idea', buildArgs: (f) => [f] },
    { id: 'sublime', name: 'Sublime Text', bin: 'subl', buildArgs: (f) => [f] },
    { id: 'gnome-terminal', name: 'GNOME Terminal', bin: 'gnome-terminal', buildArgs: (f) => [`--working-directory=${f}`] },
    { id: 'konsole', name: 'Konsole', bin: 'konsole', buildArgs: (f) => ['--workdir', f] },
  ],
};

/** A detected, ready-to-launch opener. */
interface ResolvedOpener {
  id: string;
  name: string;
  /** Reveal the folder via `shell.openPath` (file managers) instead of launching. */
  shellOpen: boolean;
  buildArgs: (folder: string) => string[];
  /** macOS/Linux: the resolved binary to `spawn`. */
  spawnCommand: string;
  /** macOS/Linux: `.cmd`/`.bat` shims must be spawned through a shell. */
  spawnShell: boolean;
  /** Windows: the real program handed to `start` (a `.exe`, or the bin name). */
  winLaunch: string;
  /** Path handed to `app.getFileIcon` for the native icon, if any. */
  iconSource: string | null;
  /** Bundled-PNG stem to use as icon (fallback, or forced) — see `openerIcons.ts`. */
  bundledIcon: string | null;
}

/** Quote a single Windows argument for a `start`-wrapped command line. */
export function quoteWinArg(s: string): string {
  return /\s/.test(s) && !/^".*"$/.test(s) ? `"${s}"` : s;
}

/**
 * Build the `start`-wrapped Windows command line that launches `command args…`.
 * `start` returns immediately (so `exec` never hangs), fully detaches the child,
 * and gives console programs (cmd / PowerShell) a visible window while GUI apps
 * open normally. The empty `""` is `start`'s (ignored) window title; every token
 * is quoted so paths/args with spaces survive.
 */
export function winConsoleCommand(command: string, args: string[]): string {
  return ['start', '""', quoteWinArg(command), ...args.map(quoteWinArg)].join(' ');
}

const currentPlatform = (): Platform =>
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

/** Cache of resolved openers, keyed by id (rebuilt on each `listOpeners()`). */
let resolved = new Map<string, ResolvedOpener>();

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a CLI on PATH via `where` (Windows) / `which` (POSIX). Null if absent. */
function lookupCli(bin: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    try {
      execFile(cmd, [bin], { timeout: 1500, windowsHide: true }, (err, stdout) => {
        if (err || typeof stdout !== 'string') return resolve(null);
        const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
        resolve(first ? first.trim() : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Expand `%VAR%` references in a Windows path against the current env. */
function expandEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? '');
}

/** Helper/uninstaller exes that share a name prefix but aren't the app itself. */
const HELPER_EXE = /(unins|tunnel|setup|install|update|helper|crash|node)/i;

/**
 * Walk up from a launcher shim (a `.cmd`, or an extension-less shell script — a
 * `where code` often resolves to `…\bin\code`) looking for the real `.exe` whose
 * icon we can extract. Many CLIs (code / cursor / windsurf) ship the shim in a
 * `bin\` subdir with the actual `<Name>.exe` a few directories up. Prefers an
 * exact `<bin>.exe` (nearest level first); falls back to the nearest name-matching
 * `.exe` that isn't an obvious helper. Windows fs is case-insensitive.
 */
async function findExeNearShim(shimPath: string, binName: string): Promise<string | null> {
  const base = binName.replace(/\.exe$/i, '').toLowerCase();
  const wanted = `${base}.exe`;
  let dir = path.dirname(shimPath);
  let fuzzy: string | null = null;
  for (let i = 0; i < 6; i++) {
    try {
      const entries = await fs.readdir(dir);
      const exact = entries.find((e) => e.toLowerCase() === wanted);
      if (exact) return path.join(dir, exact); // exact match wins immediately
      if (!fuzzy) {
        const f = entries.find(
          (e) =>
            e.toLowerCase().endsWith('.exe') &&
            e.toLowerCase().includes(base) &&
            !HELPER_EXE.test(e),
        );
        if (f) fuzzy = path.join(dir, f);
      }
    } catch {
      /* unreadable dir — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fuzzy;
}

/** First existing Windows `winIconPaths` candidate (absolute real exe), or null. */
async function findWinExe(r: OpenerRecipe): Promise<string | null> {
  for (const cand of r.winIconPaths ?? []) {
    const abs = expandEnv(cand);
    if (abs && (await fileExists(abs))) return abs;
  }
  return null;
}

/**
 * Resolve the best path to hand `app.getFileIcon`. Prefers a known-existing exe
 * candidate, then the resolved bin if it's already an exe, then the real exe near
 * a shim; on macOS the `.app` bundle, on Linux the resolved binary. Null when
 * nothing usable is found (the renderer falls back to a bundled/generic icon).
 */
async function resolveIconSource(
  r: OpenerRecipe,
  foundPath: string | null,
  winExe: string | null,
): Promise<string | null> {
  if (process.platform === 'win32') {
    if (winExe) return winExe;
    if (foundPath && /\.exe$/i.test(foundPath)) return foundPath;
    // Not an exe (a `.cmd`/`.bat` or extension-less shim) → find the real exe.
    if (foundPath) {
      const exe = await findExeNearShim(foundPath, r.bin);
      if (exe) return exe;
    }
    return foundPath;
  }
  // macOS: the `.app` bundle carries the icon; Linux: the resolved binary.
  return r.iconPath ?? r.appBundle ?? foundPath ?? null;
}

/** Resolve a single recipe on this machine, or null if the program isn't present. */
async function resolveRecipe(r: OpenerRecipe): Promise<ResolvedOpener | null> {
  const foundPath = await lookupCli(r.bin);
  const bundleOk = r.appBundle ? await fileExists(r.appBundle) : true;
  // Windows GUI apps (Android Studio / IntelliJ / Sublime / Visual Studio) aren't
  // on PATH, so `where` finds nothing — an existing `winIconPaths` candidate is
  // what proves they're installed (and is the exe we launch + extract the icon from).
  const winExe = process.platform === 'win32' ? await findWinExe(r) : null;
  const available =
    bundleOk && (r.alwaysAvailable || !!foundPath || !!r.appBundle || !!winExe);
  if (!available) return null;

  const iconSource = r.forceBundledIcon ? null : await resolveIconSource(r, foundPath, winExe);
  // Windows launches go through `start <real-exe>`. Prefer a known-existing exe
  // (unambiguous, avoids the un-runnable `.cmd`/shell-script shim), but fall back
  // to the bin name for app-execution aliases under WindowsApps (e.g. `wt.exe`),
  // which `start` resolves off PATH.
  const launchExe = winExe ?? iconSource;
  const isWinAppsAlias = !!launchExe && /[\\/]WindowsApps[\\/]/i.test(launchExe);
  const winLaunch = launchExe && /\.exe$/i.test(launchExe) && !isWinAppsAlias ? launchExe : r.bin;
  const spawnCommand = foundPath ?? r.bin;
  const spawnShell = !!foundPath && /\.(cmd|bat)$/i.test(foundPath);
  return {
    id: r.id,
    name: r.name,
    shellOpen: !!r.shellOpen,
    buildArgs: r.buildArgs,
    spawnCommand,
    spawnShell,
    winLaunch,
    iconSource,
    bundledIcon: r.bundledIcon ?? null,
  };
}

/**
 * Detect every catalogued program installed locally on this platform. Always
 * resolves (never throws); probes run in parallel with short timeouts. Caches the
 * resolved launchers so `openWith`/`openerIconSource` can use them.
 */
export async function listOpeners(): Promise<OpenerInfo[]> {
  const recipes = PLATFORM_OPENERS[currentPlatform()] ?? [];
  const results = await Promise.all(recipes.map((r) => resolveRecipe(r).catch(() => null)));
  const next = new Map<string, ResolvedOpener>();
  const list: OpenerInfo[] = [];
  for (const r of results) {
    if (!r) continue;
    next.set(r.id, r);
    list.push({ id: r.id, name: r.name });
  }
  resolved = next;
  return list;
}

/**
 * Icon sources for every currently-detected opener, so the IPC layer can extract
 * them all in the background after `listOpeners`. `path` feeds `app.getFileIcon`;
 * `bundledIcon` is a PNG stem used when extraction yields nothing (or is forced).
 */
export function resolvedIconSources(): Array<{
  id: string;
  path: string | null;
  bundledIcon: string | null;
}> {
  return [...resolved.values()].map((o) => ({
    id: o.id,
    path: o.iconSource,
    bundledIcon: o.bundledIcon,
  }));
}

/**
 * How to open `folder` in a detected opener. Kept electron-free — the IPC layer
 * executes it (`shell.openPath` / `exec` / `spawn`) so this module stays testable:
 *  - `shellOpen`  → `shell.openPath(folder)` (file managers).
 *  - `exec`       → Windows: `start "" <real-exe> <args>`; detaches, and gives
 *                   console apps (cmd/powershell) a visible window automatically.
 *  - `spawn`      → macOS/Linux: spawn the resolved binary detached.
 */
export type LaunchPlan =
  | { kind: 'shellOpen' }
  | { kind: 'exec'; commandLine: string }
  | { kind: 'spawn'; command: string; args: string[]; shell: boolean };

/**
 * Resolve how to launch a previously-detected opener on `folder`. Re-detects once
 * if the id is missing (menu opened from a stale state). Null on unknown id.
 */
export async function resolveLaunch(id: string, folder: string): Promise<LaunchPlan | null> {
  if (!resolved.has(id)) await listOpeners();
  const o = resolved.get(id);
  if (!o) return null;
  if (o.shellOpen) return { kind: 'shellOpen' };
  const args = o.buildArgs(folder);
  if (process.platform === 'win32') {
    return { kind: 'exec', commandLine: winConsoleCommand(o.winLaunch, args) };
  }
  return { kind: 'spawn', command: o.spawnCommand, args, shell: o.spawnShell };
}
