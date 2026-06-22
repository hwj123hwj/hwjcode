/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Detect locally-installed editors / IDEs for the file browser's "Open in" menu
 * and launch them on a file or folder. Detection is data-driven (one entry per
 * IDE) and best-effort: an IDE only appears in the menu when we can resolve a
 * concrete launch command for it on this platform.
 *
 * The resolved launch spec is cached in-process (keyed by IDE id) so the
 * renderer only ever sees `{ id, name }` and never a raw command line.
 */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import type { DetectedIde } from '../shared/ipc.js';

/** A resolved, ready-to-spawn launcher for one detected IDE. */
interface ResolvedIde {
  id: string;
  name: string;
  command: string;
  /** Args placed before the target path (e.g. `open -a "Cursor"`). */
  baseArgs: string[];
  /** npx-style commands on Windows need a shell to resolve `.cmd` shims. */
  shell: boolean;
}

/** Declarative detection recipe for one IDE, per platform. */
interface IdeRecipe {
  id: string;
  name: string;
  /** Windows: absolute exe candidates (may contain %ENV% refs) + CLI shim names. */
  win?: { paths?: string[]; cli?: string[] };
  /** macOS: a .app bundle name launched via `open -a`, plus optional CLI names. */
  mac?: { app?: string; cli?: string[] };
  /** Linux: CLI launcher names probed on PATH. */
  linux?: { cli?: string[] };
}

const LOCALAPPDATA = '%LOCALAPPDATA%';
const PF = '%ProgramFiles%';
const PF86 = '%ProgramFiles(x86)%';

/**
 * The IDE catalog. Keep ids stable — the renderer passes them back to `open`.
 * Ordered roughly by popularity so the menu reads sensibly.
 */
const RECIPES: IdeRecipe[] = [
  {
    id: 'vscode',
    name: 'VS Code',
    win: {
      paths: [
        `${LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe`,
        `${PF}\\Microsoft VS Code\\Code.exe`,
      ],
      cli: ['code'],
    },
    mac: { app: 'Visual Studio Code', cli: ['code'] },
    linux: { cli: ['code', 'codium'] },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    win: {
      paths: [`${LOCALAPPDATA}\\Programs\\cursor\\Cursor.exe`],
      cli: ['cursor'],
    },
    mac: { app: 'Cursor', cli: ['cursor'] },
    linux: { cli: ['cursor'] },
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    win: {
      paths: [`${PF}\\Sublime Text\\sublime_text.exe`, `${PF}\\Sublime Text 3\\sublime_text.exe`],
      cli: ['subl'],
    },
    mac: { app: 'Sublime Text', cli: ['subl'] },
    linux: { cli: ['subl'] },
  },
  {
    id: 'intellij',
    name: 'IntelliJ IDEA',
    win: { cli: ['idea', 'idea64'] },
    mac: { app: 'IntelliJ IDEA', cli: ['idea'] },
    linux: { cli: ['idea', 'idea.sh'] },
  },
  {
    id: 'android-studio',
    name: 'Android Studio',
    win: {
      paths: [`${PF}\\Android\\Android Studio\\bin\\studio64.exe`],
      cli: ['studio', 'studio64'],
    },
    mac: { app: 'Android Studio', cli: ['studio'] },
    linux: { cli: ['studio.sh'] },
  },
  {
    id: 'webstorm',
    name: 'WebStorm',
    win: { cli: ['webstorm', 'webstorm64'] },
    mac: { app: 'WebStorm', cli: ['webstorm'] },
    linux: { cli: ['webstorm', 'webstorm.sh'] },
  },
  {
    id: 'visual-studio',
    name: 'Visual Studio',
    win: {
      paths: [
        `${PF}\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe`,
        `${PF}\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe`,
        `${PF}\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe`,
        `${PF86}\\Microsoft Visual Studio\\2019\\Community\\Common7\\IDE\\devenv.exe`,
      ],
      cli: ['devenv'],
    },
  },
];

/** Cache of resolved launchers, rebuilt on each `detectIdes()` call. */
let resolved = new Map<string, ResolvedIde>();

/** Expand `%VAR%` references in a Windows path against the current env. */
function expandEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? '');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a CLI launcher on PATH via `where` (Windows) / `which` (POSIX). */
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

/** Resolve a single recipe to a launcher on this platform, or null if absent. */
async function resolveRecipe(r: IdeRecipe): Promise<ResolvedIde | null> {
  const mk = (command: string, baseArgs: string[] = [], shell = false): ResolvedIde => ({
    id: r.id,
    name: r.name,
    command,
    baseArgs,
    shell,
  });

  if (process.platform === 'win32' && r.win) {
    for (const candidate of r.win.paths ?? []) {
      const abs = expandEnv(candidate);
      if (abs && (await fileExists(abs))) return mk(abs);
    }
    for (const bin of r.win.cli ?? []) {
      const found = await lookupCli(bin);
      // `where` returns the resolved path; spawning a `.cmd` shim needs a shell.
      if (found) return mk(found, [], /\.(cmd|bat)$/i.test(found));
    }
    return null;
  }

  if (process.platform === 'darwin' && r.mac) {
    if (r.mac.app) {
      const bundle = `/Applications/${r.mac.app}.app`;
      if (await fileExists(bundle)) return mk('open', ['-a', r.mac.app]);
    }
    for (const bin of r.mac.cli ?? []) {
      const found = await lookupCli(bin);
      if (found) return mk(found);
    }
    return null;
  }

  if (process.platform === 'linux' && r.linux) {
    for (const bin of r.linux.cli ?? []) {
      const found = await lookupCli(bin);
      if (found) return mk(found);
    }
    return null;
  }

  return null;
}

/**
 * Detect every IDE in the catalog that is installed locally. Always resolves
 * (never throws); probes run in parallel with short timeouts so a slow PATH
 * scan can't stall the file browser.
 */
export async function detectIdes(): Promise<DetectedIde[]> {
  const results = await Promise.all(RECIPES.map((r) => resolveRecipe(r).catch(() => null)));
  const next = new Map<string, ResolvedIde>();
  const list: DetectedIde[] = [];
  for (const r of results) {
    if (!r) continue;
    next.set(r.id, r);
    list.push({ id: r.id, name: r.name });
  }
  resolved = next;
  return list;
}

/**
 * Launch a previously-detected IDE on a file/folder path. Detection must have
 * run at least once this session (the renderer always calls `detect` before
 * showing the menu). No-ops on an unknown id.
 */
export async function openInIde(ideId: string, target: string): Promise<void> {
  const ide = resolved.get(ideId);
  if (!ide) {
    // Re-detect once in case the menu was opened from a stale cache.
    await detectIdes();
  }
  const launcher = resolved.get(ideId);
  if (!launcher) throw new Error(`IDE not available: ${ideId}`);
  const child = spawn(launcher.command, [...launcher.baseArgs, target], {
    detached: true,
    stdio: 'ignore',
    shell: launcher.shell,
    windowsHide: true,
  });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Open a native terminal at `dir`. Best-effort per platform: Windows Terminal →
 * PowerShell fallback on Windows, Terminal.app on macOS, common emulators on
 * Linux. Never throws.
 */
export async function openInTerminal(dir: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // Prefer Windows Terminal (`wt`) when present; otherwise a PowerShell window.
      const wt = await lookupCli('wt');
      if (wt) {
        spawn('wt', ['-d', dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return;
      }
      spawn('cmd', ['/c', 'start', 'powershell', '-NoExit', '-Command', `Set-Location -LiteralPath '${dir}'`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return;
    }
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    // Linux: try a few common emulators in order.
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      const found = await lookupCli(term);
      if (found) {
        spawn(found, [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
        return;
      }
    }
  } catch {
    /* best-effort — swallow */
  }
}
