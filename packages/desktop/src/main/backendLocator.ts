/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Locate the `easycode --acp` backend the desktop spawns per session.
 *
 * The desktop is an ACP *client*; the agent core runs in a separate process,
 * exactly like Claude Code Desktop spawns CLI sessions. We never reimplement the
 * agent — we drive the same bundle the CLI ships.
 *
 * Spawn strategy: run the backend JS under Electron-as-Node
 * (`ELECTRON_RUN_AS_NODE=1` + `process.execPath`). This avoids requiring a
 * system Node install on the user's machine — the Electron binary embeds a
 * compatible Node runtime.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface BackendSpec {
  /** Executable to spawn (the Electron binary, run as Node). */
  command: string;
  /** Args: [backendEntry, '--acp', ...]. */
  args: string[];
  /** Extra env merged over process.env. */
  env: Record<string, string>;
  /** Human description for logs. */
  description: string;
  /**
   * Spawn through a shell. Needed for external agents launched via `npx`
   * (resolves to `npx.cmd` on Windows). The bundled backend runs the Electron
   * binary directly, so it leaves this false/undefined.
   */
  shell?: boolean;
}

/** Walk up from a start dir until a path containing `bundle/easycode.js` is found. */
function findRepoBackend(): string | undefined {
  let dir = app.getAppPath();
  for (let i = 0; i < 8; i++) {
    const bundle = path.join(dir, 'bundle', 'easycode.js');
    if (existsSync(bundle)) return bundle;
    const cliDist = path.join(dir, 'packages', 'cli', 'dist', 'index.js');
    if (existsSync(cliDist)) return cliDist;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve where the agent backend entry lives, in priority order:
 *   1. EASYCODE_BACKEND_JS env override (absolute path to the .js entry)
 *   2. packaged resource: <resources>/backend/easycode.js
 *   3. repo bundle: <repoRoot>/bundle/easycode.js
 *   4. cli dist:    <repoRoot>/packages/cli/dist/index.js
 */
export function resolveBackendEntry(): string {
  const override = process.env.EASYCODE_BACKEND_JS;
  if (override && existsSync(override)) return override;

  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'backend', 'easycode.js');
    if (existsSync(packaged)) return packaged;
  }

  const repo = findRepoBackend();
  if (repo) return repo;

  throw new Error(
    'Could not locate the Easy Code agent backend. Build it with `npm run bundle` ' +
      'at the repo root, or set EASYCODE_BACKEND_JS to the absolute path of easycode.js.',
  );
}

export function buildBackendSpec(): BackendSpec {
  const entry = resolveBackendEntry();
  return {
    command: process.execPath,
    args: [entry, '--acp'],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      // Carry the same proxy/web endpoints the CLI uses. Production has these
      // baked in; we only forward overrides when present so dev (api-code/dvcode)
      // and prod both work without special-casing here.
      ...(process.env.DEEPX_SERVER_URL
        ? { DEEPX_SERVER_URL: process.env.DEEPX_SERVER_URL }
        : {}),
      ...(process.env.DEEPX_WEB_URL
        ? { DEEPX_WEB_URL: process.env.DEEPX_WEB_URL }
        : {}),
    },
    description: `Electron-as-Node ${path.basename(entry)} --acp`,
  };
}
