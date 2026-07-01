/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { PLATFORM_OPENERS, quoteWinArg, winConsoleCommand } from './workspaceOpeners.js';

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
    // Git Bash carries a bundled fallback but still tries its real exe icon first.
    expect(win['git-bash'].bundledIcon).toBe('git');
    expect(win['git-bash'].forceBundledIcon).toBeUndefined();
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
});
