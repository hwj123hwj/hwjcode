/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Integrated-terminal backend: spawns real interactive shells over a genuine
 * pseudo-terminal (PTY) and streams their raw output to the renderer, which
 * renders it with xterm.js — the same architecture VSCode uses. On Windows this
 * uses ConPTY (via `@lydell/node-pty`'s bundled conpty.dll/OpenConsole.exe), so
 * full-screen TUIs (vim, less, fzf, etc.), cursor addressing, colours and resize
 * all work exactly like a native terminal.
 *
 * `@lydell/node-pty` ships N-API prebuilt binaries through platform-specific
 * optional dependencies, so it loads in Electron with no native rebuild step —
 * see the packaging notes in electron-builder.yml (asarUnpack) and the desktop
 * memory. Each shell is keyed by an id the renderer mints UI tabs for.
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import type { ShellOption, TerminalHandle, TerminalShellKind } from '../shared/ipc.js';

interface TerminalCallbacks {
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
  /** Reads the user's chosen shell from the shared settings (may be undefined). */
  getShellPref: () => TerminalShellKind | undefined;
}

let seq = 0;
const nextId = () => `term-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** A concretely-resolved shell ready to spawn. */
interface ResolvedShell {
  command: string;
  args: string[];
  label: string;
}

/** First existing path from a candidate list, or undefined. */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((p) => {
    try {
      return p && fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/** Locate Git Bash's `bash.exe` across the usual install locations on Windows. */
function findGitBash(): string | undefined {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return firstExisting([
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
  ]);
}

function windowsPowerShell(): string | undefined {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  return firstExisting([
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]);
}

function windowsWsl(): string | undefined {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  return firstExisting([path.join(sysRoot, 'System32', 'wsl.exe')]);
}

/**
 * Resolve a concrete executable for a shell kind on the current platform.
 * Returns undefined when the shell can't be located (so the caller can fall back
 * and surface a notice). `default`/unknown resolves to the platform default.
 */
function resolveShellKind(kind: TerminalShellKind | undefined): ResolvedShell | undefined {
  if (process.platform === 'win32') {
    switch (kind) {
      case 'cmd': {
        const cmd = firstExisting([process.env.ComSpec || '']) || 'cmd.exe';
        return { command: cmd, args: [], label: 'Command Prompt' };
      }
      case 'gitbash': {
        const bash = findGitBash();
        return bash ? { command: bash, args: ['--login', '-i'], label: 'Git Bash' } : undefined;
      }
      case 'wsl': {
        const wsl = windowsWsl();
        return wsl ? { command: wsl, args: [], label: 'WSL' } : undefined;
      }
      case 'powershell':
      case 'default':
      case undefined: {
        const ps = windowsPowerShell();
        if (ps) return { command: ps, args: [], label: 'PowerShell' };
        // Last-ditch default: cmd.exe is always present.
        const cmd = process.env.ComSpec || 'cmd.exe';
        return { command: cmd, args: [], label: 'Command Prompt' };
      }
      default:
        return undefined; // a POSIX kind requested on Windows — invalid
    }
  }

  // POSIX (macOS / Linux)
  switch (kind) {
    case 'bash': {
      const bash = firstExisting(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']);
      return bash ? { command: bash, args: [], label: 'bash' } : undefined;
    }
    case 'zsh': {
      const zsh = firstExisting(['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh']);
      return zsh ? { command: zsh, args: [], label: 'zsh' } : undefined;
    }
    case 'fish': {
      const fish = firstExisting(['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish']);
      return fish ? { command: fish, args: [], label: 'fish' } : undefined;
    }
    case 'default':
    case undefined: {
      const shell = process.env.SHELL || firstExisting(['/bin/zsh', '/bin/bash']) || '/bin/sh';
      return { command: shell, args: [], label: path.basename(shell) };
    }
    default:
      return undefined; // a Windows kind requested on POSIX — invalid
  }
}

/** The shells offered for the current platform, in display order. */
function platformShellKinds(): TerminalShellKind[] {
  if (process.platform === 'win32') return ['powershell', 'cmd', 'gitbash', 'wsl'];
  if (process.platform === 'darwin') return ['zsh', 'bash', 'fish'];
  return ['bash', 'zsh', 'fish'];
}

/** List the platform's shells with an availability flag for the Settings picker. */
export function listShells(): ShellOption[] {
  return platformShellKinds().map((id) => ({
    id,
    available: !!resolveShellKind(id),
  }));
}

/** node-pty wants a string→string env map; drop undefined values. */
function ptyEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  // Advertise a 256-colour terminal so shells/programs emit rich output.
  out.TERM = out.TERM || 'xterm-256color';
  return out;
}

export class TerminalManager {
  private terms = new Map<string, IPty>();

  constructor(private readonly cb: TerminalCallbacks) {}

  /** Spawn a shell rooted at `cwd` (falling back to the home dir). */
  create(cwd?: string, cols = 80, rows = 24): TerminalHandle {
    const id = nextId();
    const pref = this.cb.getShellPref();
    // Resolve the chosen shell; if it isn't installed, fall back to the platform
    // default and tell the renderer to print a dim notice in the new terminal.
    let resolved = resolveShellKind(pref);
    let notice: string | undefined;
    if (!resolved) {
      const fallback = resolveShellKind('default')!;
      notice =
        `[Easy Code] The selected shell "${pref ?? 'default'}" was not found on this machine — ` +
        `started ${fallback.label} instead. Pick an installed shell in Settings.`;
      resolved = fallback;
    }
    const { command, args, label } = resolved;
    const cwdOk = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

    const child = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: Math.max(1, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
      cwd: cwdOk,
      env: ptyEnv(),
    });

    child.onData((data) => this.cb.onData(id, data));
    child.onExit(({ exitCode }) => {
      this.terms.delete(id);
      this.cb.onExit(id, exitCode ?? 0);
    });

    this.terms.set(id, child);
    return { id, shell: label, notice };
  }

  /** Write raw input (keystrokes, incl. control chars) to a shell's PTY. */
  input(id: string, data: string): void {
    const child = this.terms.get(id);
    if (!child) return;
    try {
      child.write(data);
    } catch {
      /* PTY may have closed under us — ignore */
    }
  }

  /** Resize a shell's PTY to match the rendered xterm grid. */
  resize(id: string, cols: number, rows: number): void {
    const child = this.terms.get(id);
    if (!child) return;
    try {
      child.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
    } catch {
      /* resizing a dead PTY throws on some platforms — ignore */
    }
  }

  /** Terminate a single shell. */
  close(id: string): void {
    const child = this.terms.get(id);
    if (!child) return;
    this.terms.delete(id);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }

  /** Kill every shell (app shutdown). */
  disposeAll(): void {
    for (const child of this.terms.values()) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this.terms.clear();
  }
}
