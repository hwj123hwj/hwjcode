/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * User Settings Service (extension host)
 * --------------------------------------------------------------------------
 * Mirrors the CLI's `packages/cli/src/config/settings.ts` and the desktop's
 * `packages/desktop/src/main/userSettings.ts` so the VSCode UI plugin reads and
 * writes the SAME `~/.easycode-user/settings.json` file the CLI's `/config`
 * command uses. A model override configured in the CLI shows up in the extension
 * (and every spawned `easycode --acp` backend) on its next read, and vice-versa.
 *
 * Currently this surfaces the `modelOverrides` key — the per-scene / per-sub-agent
 * model overrides (compression / Code Expert / Verification). We deliberately
 * read-modify-write the *whole* JSON object so the many keys the extension doesn't
 * manage (theme, hooks, mcpServers, customModels, …) are preserved untouched.
 *
 * Atomic write semantics (write to .tmp, rename) match the CLI/desktop; this avoids
 * corrupting the file if the editor crashes mid-write.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { ModelOverrides } from 'deepv-code-core';
import type { Logger } from '../utils/logger';

const SETTINGS_DIRECTORY_NAME = '.easycode-user';
const SETTINGS_FILE = 'settings.json';

/** Absolute path to `~/.easycode-user/settings.json` (shared with the CLI/desktop). */
export function getUserSettingsFilePath(): string {
  return path.join(homedir(), SETTINGS_DIRECTORY_NAME, SETTINGS_FILE);
}

/** Lightweight JSON-with-comments stripper. Tolerates `// line` and block comments. */
function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Keep only the known string override fields, dropping empty/invalid entries.
 * Returns `undefined` when nothing valid remains so the key can be omitted
 * entirely (mirrors the "unset = built-in default" semantics).
 */
function sanitizeModelOverrides(value: unknown): ModelOverrides | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const src = value as Record<string, unknown>;
  const out: ModelOverrides = {};
  for (const key of ['compression', 'codeExpert', 'verification'] as const) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Stateless helper around the shared user-settings file. The only state kept is a
 * Logger reference for diagnostic messages.
 */
export class UserSettingsService {
  private static instance: UserSettingsService | null = null;
  private logger: Logger;

  private constructor(logger: Logger) {
    this.logger = logger;
  }

  static getInstance(logger: Logger): UserSettingsService {
    if (!UserSettingsService.instance) {
      UserSettingsService.instance = new UserSettingsService(logger);
    }
    return UserSettingsService.instance;
  }

  /** Read the full settings object from disk; never throws (returns {} on failure). */
  private readRaw(): Record<string, unknown> {
    const filePath = getUserSettingsFilePath();
    try {
      if (!fs.existsSync(filePath)) return {};
      const parsed = JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'utf-8')));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      this.logger.warn(`[UserSettings] Failed to read settings.json: ${String(error)}`);
      return {};
    }
  }

  /** Atomic write (temp file + rename), matching the CLI/desktop storage discipline. */
  private writeRaw(data: Record<string, unknown>): void {
    const filePath = getUserSettingsFilePath();
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const tempFilePath = filePath + '.tmp';
    fs.writeFileSync(tempFilePath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempFilePath, filePath);
  }

  /** Read the persisted per-scene / per-sub-agent model overrides (`{}` when unset). */
  getModelOverrides(): ModelOverrides {
    return sanitizeModelOverrides(this.readRaw().modelOverrides) ?? {};
  }

  /**
   * Merge the given model overrides into the shared settings file, preserving every
   * key the extension doesn't manage. An empty object (or one with no valid fields)
   * clears the override entirely (back to the built-in defaults). Returns the
   * persisted overrides.
   */
  setModelOverrides(overrides: ModelOverrides): ModelOverrides {
    const raw = this.readRaw();
    const sanitized = sanitizeModelOverrides(overrides);
    if (sanitized) raw.modelOverrides = sanitized;
    else delete raw.modelOverrides;
    this.writeRaw(raw);
    this.logger.info('[UserSettings] Updated modelOverrides in settings.json');
    return sanitized ?? {};
  }
}
