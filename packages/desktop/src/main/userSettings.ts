/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * User-settings management for the desktop app.
 *
 * These settings live in the same shared store the CLI uses —
 * `~/.easycode-user/settings.json` — the very file the CLI's `/config` command
 * reads and writes (see `packages/cli/src/config/settings.ts`,
 * `USER_SETTINGS_PATH`). A change made in the desktop's Settings dialog is
 * therefore picked up by the CLI and by every spawned `easycode --acp` backend
 * on its next start. This mirrors `customModels.ts` but for the settings file.
 *
 * We deliberately read-modify-write the *whole* JSON object so the many keys the
 * desktop doesn't surface (theme, hooks, mcpServers, customModels, …) are
 * preserved untouched.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { DesktopUserSettings, TerminalShellKind } from '../shared/ipc.js';

const TERMINAL_SHELL_KINDS: TerminalShellKind[] = [
  'default',
  'powershell',
  'cmd',
  'gitbash',
  'wsl',
  'bash',
  'zsh',
  'fish',
];

const SETTINGS_DIRECTORY_NAME = '.easycode-user';
const SETTINGS_FILE = 'settings.json';
/**
 * Global custom-instructions file: the user's home-level memory the agent loads
 * for every task on this machine (NOT a project's `.easycode/DEEPV.md`). Shared
 * with the CLI/backend, which read it from the same path on session start.
 */
const INSTRUCTIONS_FILE = 'DEEPV.md';

function filePath(): string {
  return path.join(homedir(), SETTINGS_DIRECTORY_NAME, SETTINGS_FILE);
}

function instructionsPath(): string {
  return path.join(homedir(), SETTINGS_DIRECTORY_NAME, INSTRUCTIONS_FILE);
}

/** Read the full settings object from disk; never throws (returns {} on failure). */
function readRaw(): Record<string, unknown> {
  try {
    const fp = filePath();
    if (!fs.existsSync(fp)) return {};
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    console.warn('[userSettings] Failed to read settings.json:', err);
    return {};
  }
}

/** Atomic write (temp file + rename), matching the CLI's storage discipline. */
function writeRaw(data: Record<string, unknown>): void {
  const fp = filePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
}

/** Project the full settings file down to the subset the desktop exposes. */
function project(raw: Record<string, unknown>): DesktopUserSettings {
  const out: DesktopUserSettings = {};
  if (typeof raw.preferredLanguage === 'string') out.preferredLanguage = raw.preferredLanguage;
  if (typeof raw.defaultModel === 'string') out.defaultModel = raw.defaultModel;
  if (typeof raw.healthyUse === 'boolean') out.healthyUse = raw.healthyUse;
  if (
    raw.projectMemoryMode === 'all' ||
    raw.projectMemoryMode === 'deepv-only' ||
    raw.projectMemoryMode === 'none'
  ) {
    out.projectMemoryMode = raw.projectMemoryMode;
  }
  if (
    typeof raw.terminalShell === 'string' &&
    TERMINAL_SHELL_KINDS.includes(raw.terminalShell as TerminalShellKind)
  ) {
    out.terminalShell = raw.terminalShell as TerminalShellKind;
  }
  if (typeof raw.computerUseEnabled === 'boolean') {
    out.computerUseEnabled = raw.computerUseEnabled;
  }
  return out;
}

/** The desktop-exposed subset of the shared user settings. */
export function getUserSettings(): DesktopUserSettings {
  return project(readRaw());
}

/**
 * Merge a partial update into the shared settings file, preserving every key the
 * desktop doesn't manage. Pass `preferredLanguage: ''` to clear the language
 * (the key is removed). Returns the new desktop-exposed state.
 */
export function updateUserSettings(patch: DesktopUserSettings): DesktopUserSettings {
  const raw = readRaw();

  if ('preferredLanguage' in patch) {
    const v = patch.preferredLanguage?.trim();
    if (v) raw.preferredLanguage = v;
    else delete raw.preferredLanguage;
  }
  if ('defaultModel' in patch) {
    const v = patch.defaultModel?.trim();
    if (v) raw.defaultModel = v;
    else delete raw.defaultModel; // empty = clear (back to backend default)
  }
  if ('healthyUse' in patch && typeof patch.healthyUse === 'boolean') {
    raw.healthyUse = patch.healthyUse;
  }
  if ('projectMemoryMode' in patch && patch.projectMemoryMode) {
    raw.projectMemoryMode = patch.projectMemoryMode;
  }
  if ('terminalShell' in patch && patch.terminalShell) {
    if (patch.terminalShell === 'default') delete raw.terminalShell;
    else raw.terminalShell = patch.terminalShell;
  }
  if ('computerUseEnabled' in patch && typeof patch.computerUseEnabled === 'boolean') {
    raw.computerUseEnabled = patch.computerUseEnabled;
  }

  writeRaw(raw);
  return project(raw);
}

/**
 * Read the global custom-instructions (`~/.easycode-user/DEEPV.md`). Returns an
 * empty string when the file doesn't exist yet; never throws.
 */
export function getCustomInstructions(): string {
  try {
    const fp = instructionsPath();
    if (!fs.existsSync(fp)) return '';
    return fs.readFileSync(fp, 'utf-8');
  } catch (err) {
    console.warn('[userSettings] Failed to read DEEPV.md:', err);
    return '';
  }
}

/**
 * Write the global custom-instructions (`~/.easycode-user/DEEPV.md`) atomically.
 * An empty/whitespace-only body removes the file so the agent loads no global
 * instructions. Returns the persisted content.
 */
export function saveCustomInstructions(content: string): string {
  const fp = instructionsPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  if (!content.trim()) {
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (err) {
      console.warn('[userSettings] Failed to remove DEEPV.md:', err);
    }
    return '';
  }
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, fp);
  return content;
}
