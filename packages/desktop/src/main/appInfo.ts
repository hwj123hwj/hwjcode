/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Assemble the "About" version/environment snapshot the renderer shows in the
 * Settings → 关于 panel — a VSCode-style block of the app version, the runtime
 * (Electron/Chromium/Node/V8), the OS, and the version of the bundled
 * `easycode --acp` backend (`easycode-cli-core`).
 */

import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { app } from 'electron';
import { resolveBackendEntry } from './backendLocator.js';
import type { VersionInfo } from '../shared/ipc.js';

/**
 * The slice of `node:fs` {@link nearestPackageVersion} needs, narrowed to a
 * sync read so the lookup stays a pure, injectable function (the unit test
 * passes a fake instead of touching disk).
 */
export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string): string;
}

const realFs: FsLike = {
  existsSync,
  readFileSync: (p) => readFileSync(p, 'utf8'),
};

/**
 * Walk up from `startFile`'s directory looking for the nearest `package.json`
 * that carries a non-empty `version`, and return it. Mirrors how the CLI finds
 * its own identity via `readPackageUp`.
 *
 * Used to read the bundled backend's version from the `package.json` shipped
 * beside its entry — `bundle/package.json` next to `bundle/easycode.js`, or
 * `<resources>/backend/package.json` in a packaged build, or (dev fallback)
 * `packages/cli/package.json` one level above `packages/cli/dist/index.js`.
 *
 * Malformed / version-less `package.json` files are skipped so the walk keeps
 * climbing instead of giving up at the first hit. Returns `undefined` when no
 * versioned `package.json` is found within `maxLevels`.
 */
export function nearestPackageVersion(
  startFile: string,
  fs: FsLike = realFs,
  maxLevels = 8,
): string | undefined {
  let dir = path.dirname(startFile);
  for (let i = 0; i < maxLevels; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath)) as { version?: unknown };
        if (typeof parsed.version === 'string' && parsed.version) return parsed.version;
      } catch {
        // Ignore a malformed package.json and keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return undefined;
}

/**
 * Version of the bundled `easycode --acp` backend (`easycode-cli-core`).
 *
 * Best-effort: `resolveBackendEntry` throws when no backend can be located
 * (e.g. a fresh checkout with neither `bundle/` nor `packages/cli/dist`); we
 * never let that surface in the About panel, falling back to `'unknown'`.
 */
export function getBundledCliVersion(): string {
  try {
    return nearestPackageVersion(resolveBackendEntry()) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Build the full About snapshot from the running process + bundled backend. */
export function getVersionInfo(): VersionInfo {
  return {
    desktop: app.getVersion(),
    cliCore: getBundledCliVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    v8: process.versions.v8 ?? '',
    // e.g. "Windows_NT x64 10.0.26220" — mirrors VSCode's About line.
    os: `${os.type()} ${os.arch()} ${os.release()}`,
  };
}
