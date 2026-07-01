/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  PLATFORM_OPENERS,
  quoteWinArg,
  winConsoleCommand,
  resolveMacLaunch,
} from './workspaceOpeners.js';

describe('quoteWinArg', () => {
  it('quotes args containing whitespace', () => {
    expect(quoteWinArg('C:\\my folder')).toBe('"C:\\my folder"');
    expect(quoteWinArg("cd 'C:\\my folder'")).toBe('"cd \'C:\\my folder\'"');
  });
  it('leaves whitespace-free args untouched', () => {
    expect(quoteWinArg('-NoExit')).toBe('-NoExit');
    expect(quoteWinArg('cmd.exe')).toBe('cmd.exe');
  });
  it('does not double-quote an already-quoted arg', () => {
    expect(quoteWinArg('"already quoted"')).toBe('"already quoted"');
  });
});

describe('winConsoleCommand', () => {
  it('wraps a PowerShell launch with start + empty title, quoting the cd command', () => {
    const cmd = winConsoleCommand('powershell.exe', ['-NoExit', '-Command', "cd 'C:\\my folder'"]);
    expect(cmd).toBe('start "" powershell.exe -NoExit -Command "cd \'C:\\my folder\'"');
  });
  it('wraps a CMD launch, quoting the cd /d argument with the folder', () => {
    const cmd = winConsoleCommand('cmd.exe', ['/K', 'cd /d C:\\proj']);
    expect(cmd).toBe('start "" cmd.exe /K "cd /d C:\\proj"');
  });
});

describe('PLATFORM_OPENERS catalog', () => {
  it('builds the documented args per program', () => {
    const win = Object.fromEntries(PLATFORM_OPENERS.win32.map((o) => [o.id, o]));
    expect(win.explorer.buildArgs('C:\\p')).toEqual(['C:\\p']);
    expect(win.wt.buildArgs('C:\\p')).toEqual(['-d', 'C:\\p']);
    expect(win.powershell.buildArgs('C:\\p')).toEqual(['-NoExit', '-Command', "cd 'C:\\p'"]);
    expect(win.cmd.buildArgs('C:\\p')).toEqual(['/K', 'cd /d C:\\p']);
    // Newly-added programs open the folder as a project / cd into it.
    expect(win['android-studio'].buildArgs('C:\\p')).toEqual(['C:\\p']);
    expect(win.intellij.buildArgs('C:\\p')).toEqual(['C:\\p']);
    expect(win.sublime.buildArgs('C:\\p')).toEqual(['C:\\p']);
    expect(win['visual-studio'].buildArgs('C:\\p')).toEqual(['C:\\p']);
    expect(win['git-bash'].buildArgs('C:\\p')).toEqual(['--cd=C:\\p']);
    expect(win.wsl.buildArgs('C:\\p')).toEqual(['--cd', 'C:\\p']);

    const mac = Object.fromEntries(PLATFORM_OPENERS.darwin.map((o) => [o.id, o]));
    expect(mac.iterm.buildArgs('/p')).toEqual(['-a', 'iTerm', '/p']);
    expect(mac.terminal.buildArgs('/p')).toEqual(['-a', 'Terminal', '/p']);
    expect(mac['android-studio'].buildArgs('/p')).toEqual(['-a', 'Android Studio', '/p']);
    expect(mac.intellij.buildArgs('/p')).toEqual(['-a', 'IntelliJ IDEA', '/p']);
    expect(mac.sublime.buildArgs('/p')).toEqual(['-a', 'Sublime Text', '/p']);

    const linux = Object.fromEntries(PLATFORM_OPENERS.linux.map((o) => [o.id, o]));
    expect(linux['gnome-terminal'].buildArgs('/p')).toEqual(['--working-directory=/p']);
    expect(linux.konsole.buildArgs('/p')).toEqual(['--workdir', '/p']);
    expect(linux['android-studio'].buildArgs('/p')).toEqual(['/p']);
    expect(linux.intellij.buildArgs('/p')).toEqual(['/p']);
    expect(linux.sublime.buildArgs('/p')).toEqual(['/p']);
  });

  it('flags Windows Terminal to use its bundled icon (WindowsApps exe is unreadable)', () => {
    const win = Object.fromEntries(PLATFORM_OPENERS.win32.map((o) => [o.id, o]));
    expect(win.wt.bundledIcon).toBe('terminal');
    expect(win.wt.forceBundledIcon).toBe(true);
    // Git Bash's exe carries no extractable icon (a generic console glyph), so it
    // forces the bundled Git PNG — same treatment as Windows Terminal.
    expect(win['git-bash'].bundledIcon).toBe('git');
    expect(win['git-bash'].forceBundledIcon).toBe(true);
  });

  it('marks file managers for shell.openPath (not a spawn/exec launch)', () => {
    const byId = (list: typeof PLATFORM_OPENERS.win32) =>
      Object.fromEntries(list.map((o) => [o.id, o]));
    expect(byId(PLATFORM_OPENERS.win32).explorer.shellOpen).toBe(true);
    expect(byId(PLATFORM_OPENERS.darwin).finder.shellOpen).toBe(true);
    expect(byId(PLATFORM_OPENERS.linux)['file-manager'].shellOpen).toBe(true);
    // Editors/terminals are NOT shell-open.
    expect(byId(PLATFORM_OPENERS.win32).vscode.shellOpen).toBeUndefined();
    expect(byId(PLATFORM_OPENERS.win32).cmd.shellOpen).toBeUndefined();
  });

  it('keeps every id unique within a platform', () => {
    for (const list of Object.values(PLATFORM_OPENERS)) {
      const ids = list.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('gives macOS CLI-first editors an .app bundle + open-a fallback name', () => {
    // Detection must not depend on the `code`/`cursor`/`windsurf` CLI shim being
    // on PATH (a Finder/Dock GUI launch has a minimal PATH, and many users never
    // install the shim). The `.app` bundle proves the editor is installed; the
    // macAppName drives an `open -a` launch fallback when the CLI is absent.
    const mac = Object.fromEntries(PLATFORM_OPENERS.darwin.map((o) => [o.id, o]));
    expect(mac.vscode.appBundle).toBe('/Applications/Visual Studio Code.app');
    expect(mac.vscode.macAppName).toBe('Visual Studio Code');
    expect(mac.cursor.appBundle).toBe('/Applications/Cursor.app');
    expect(mac.cursor.macAppName).toBe('Cursor');
    expect(mac.windsurf.appBundle).toBe('/Applications/Windsurf.app');
    expect(mac.windsurf.macAppName).toBe('Windsurf');
  });
});

describe('resolveMacLaunch', () => {
  const vscode = { bin: 'code', macAppName: 'Visual Studio Code', buildArgs: (f: string) => [f] };

  it('spawns the CLI shim with its args when the CLI is found on PATH', () => {
    const plan = resolveMacLaunch(vscode, '/usr/local/bin/code', '/proj');
    expect(plan).toEqual({ command: '/usr/local/bin/code', args: ['/proj'] });
  });

  it('falls back to `open -a <AppName>` when the CLI shim is absent', () => {
    // VS Code installed as an .app but with no `code` shim on PATH — the common
    // case that previously made the editor un-launchable from the menu.
    const plan = resolveMacLaunch(vscode, null, '/proj');
    expect(plan).toEqual({ command: 'open', args: ['-a', 'Visual Studio Code', '/proj'] });
  });

  it('spawns the recipe bin as-is when no CLI and no macAppName (e.g. open -a recipes)', () => {
    // iTerm/Terminal already have bin `open` + args `['-a', 'iTerm', folder]`, so
    // with no macAppName they just spawn the bin with the recipe args.
    const iterm = { bin: 'open', buildArgs: (f: string) => ['-a', 'iTerm', f] };
    const plan = resolveMacLaunch(iterm, null, '/proj');
    expect(plan).toEqual({ command: 'open', args: ['-a', 'iTerm', '/proj'] });
  });
});
