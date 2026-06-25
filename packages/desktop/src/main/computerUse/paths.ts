/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * The desktop-managed "system settings" file that injects the computer-use MCP
 * server into every `easycode --acp` backend the desktop spawns — and ONLY
 * those backends.
 *
 * The core loads `mcpServers` from a merged user/workspace/**system** settings
 * stack, where the system-settings path is overridable via the
 * `GEMINI_CLI_SYSTEM_SETTINGS_PATH` env var (see core
 * `getSystemSettingsPath()`). The desktop points that env at this file for its
 * spawns (see backendLocator), so the computer-use tool reaches desktop backends
 * without touching the shared `~/.easycode-user/settings.json` and without ever
 * leaking into standalone CLI runs (which don't set the env). The file's MCP
 * entry is present only while the user has enabled computer use, so the toggle
 * is honored by every newly-spawned backend.
 */

import * as path from 'node:path';
import { homedir } from 'node:os';

/** Absolute path of the desktop-only system-settings file. */
export function desktopSystemSettingsPath(): string {
  return path.join(homedir(), '.easycode-user', 'desktop-system-settings.json');
}

/** The MCP server name registered for computer use (also its tool prefix). */
export const COMPUTER_USE_SERVER_NAME = 'easycode-computer-use';
