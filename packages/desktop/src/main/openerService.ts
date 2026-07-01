/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Caching + persistence layer for the "Open workspace with…" menu, sitting on top
 * of the electron-free `workspaceOpeners` catalog and the `openerIcons` extractor.
 *
 * Two jobs the pure modules can't do:
 *  1. **Background preload** — detecting installed programs and extracting their
 *     icons is slow (child processes + `app.getFileIcon`). `preloadOpeners()` runs
 *     it once, silently, right after the app is ready, and caches the result so the
 *     first menu open is instant instead of showing a spinner.
 *  2. **Remember the last choice** — the split-button UI defaults to whatever the
 *     user last opened. Persisted to `openers.json` beside `sessions.json` in the
 *     app's userData dir (same convention as the rest of the desktop's state).
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OpenerInfo } from '../shared/ipc.js';
import { listOpeners, resolvedIconSources } from './workspaceOpeners.js';
import { loadOpenerIcons } from './openerIcons.js';

/** Cached opener list (with inline icons), populated by the first build. */
let cache: OpenerInfo[] | null = null;
/** In-flight build, so concurrent callers share one detection pass. */
let inflight: Promise<OpenerInfo[]> | null = null;

/** Detect every installed program and extract each one's icon inline. */
async function build(): Promise<OpenerInfo[]> {
  const list = await listOpeners();
  const icons = await loadOpenerIcons(resolvedIconSources());
  return list.map((o) => ({ ...o, icon: icons.get(o.id) ?? null }));
}

/**
 * The detected openers (with icons), from cache when available. Concurrent calls
 * before the first build finishes share the same in-flight detection.
 */
export async function getOpeners(): Promise<OpenerInfo[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = build()
      .then((r) => {
        cache = r;
        inflight = null;
        return r;
      })
      .catch((e) => {
        inflight = null;
        throw e;
      });
  }
  return inflight;
}

/**
 * Warm the cache in the background (fire-and-forget). Called after app-ready so the
 * first time the user opens the menu the list + icons are already there. Failures
 * are swallowed — the on-demand `getOpeners()` path retries.
 */
export function preloadOpeners(): void {
  void getOpeners().catch(() => undefined);
}

/** `openers.json` beside `sessions.json` in the app's userData dir. */
function prefsPath(): string {
  return path.join(app.getPath('userData'), 'openers.json');
}

/** The id of the program the user last opened a workspace with, or null. */
export function getLastOpenerId(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as { lastOpenerId?: unknown };
    return typeof parsed.lastOpenerId === 'string' ? parsed.lastOpenerId : null;
  } catch {
    return null;
  }
}

/** Remember the program the user last opened a workspace with (best-effort). */
export function setLastOpenerId(id: string): void {
  try {
    const tmp = `${prefsPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lastOpenerId: id }, null, 2), 'utf8');
    fs.renameSync(tmp, prefsPath());
  } catch {
    /* non-fatal — the choice just isn't remembered across restarts */
  }
}
