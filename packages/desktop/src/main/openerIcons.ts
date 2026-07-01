/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Native-icon extraction for the "Open workspace with…" menu. Kept apart from
 * `workspaceOpeners.ts` (which is electron-free / unit-tested) because it needs
 * Electron's `app.getFileIcon` (and bundled PNG assets).
 *
 * `app.getFileIcon` on Windows requires the **real absolute path of an `.exe`**
 * (never a `.cmd`/shell-script shim), which is why `workspaceOpeners` resolves
 * `iconSource` to the actual executable. Some programs, though, expose no
 * readable exe at all — Windows Terminal's `wt.exe` is an app-execution alias
 * under `WindowsApps`, which the user can't read — so those ship a **bundled PNG**
 * (downloaded into `assets/icons/`) used directly instead of / as a fallback to
 * the native icon. Icons are extracted here in one batch right after detection and
 * returned inline with the opener list, so the renderer gets each program's icon
 * without a second round-trip.
 */

import { app } from 'electron';
import * as fs from 'node:fs/promises';

// Bundled PNGs, imported via electron-vite's `?asset` so they're emitted into the
// build and resolve to a real on-disk path at runtime (same pattern as the app
// window icon). Keyed by the stem a recipe's `bundledIcon` references.
import terminalIcon from '../../assets/icons/terminal.png?asset';
import gitIcon from '../../assets/icons/git.png?asset';

const BUNDLED_ICON_PATHS: Record<string, string> = {
  terminal: terminalIcon,
  git: gitIcon,
};

/** In-process cache of already-extracted icons, keyed by source path / bundle stem. */
const cache = new Map<string, string | null>();

/** Extract a native icon (base64 data URL) for one path, or null. Cached by path. */
async function iconForPath(p: string): Promise<string | null> {
  const cached = cache.get(p);
  if (cached !== undefined) return cached;
  let result: string | null = null;
  try {
    const img = await app.getFileIcon(p, { size: 'normal' });
    result = img.isEmpty() ? null : img.toDataURL();
  } catch {
    result = null;
  }
  cache.set(p, result);
  return result;
}

/** Read a bundled PNG (by recipe stem) into a base64 data URL, or null. Cached. */
async function bundledIcon(stem: string): Promise<string | null> {
  const key = `bundled:${stem}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let result: string | null = null;
  const file = BUNDLED_ICON_PATHS[stem];
  if (file) {
    try {
      const buf = await fs.readFile(file);
      result = `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      result = null;
    }
  }
  cache.set(key, result);
  return result;
}

/**
 * Resolve one opener's icon: the native exe/app icon when available, otherwise its
 * bundled PNG fallback (or, when `path` is null — a forced-bundled program like
 * Windows Terminal — the bundled PNG directly). Null when neither yields anything.
 */
async function resolveIcon(path: string | null, stem: string | null): Promise<string | null> {
  const native = path ? await iconForPath(path) : null;
  if (native) return native;
  return stem ? await bundledIcon(stem) : null;
}

/**
 * Extract icons for every opener in parallel and return an `id → data URL | null`
 * map. Prefers the native icon, falling back to the bundled PNG when present.
 */
export async function loadOpenerIcons(
  sources: Array<{ id: string; path: string | null; bundledIcon: string | null }>,
): Promise<Map<string, string | null>> {
  const entries = await Promise.all(
    sources.map(async ({ id, path, bundledIcon: stem }): Promise<[string, string | null]> => [
      id,
      await resolveIcon(path, stem),
    ]),
  );
  return new Map(entries);
}
