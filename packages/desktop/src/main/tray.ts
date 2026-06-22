/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * System tray for the desktop app — the counterpart to the "X hides to tray"
 * window behavior wired up in `index.ts`. The tray icon brings a hidden/
 * minimized window back and offers an explicit Quit.
 *
 * The context-menu labels are localized in the main process — see
 * `trayLabels.ts` for why and how (the renderer i18n catalog isn't reachable
 * from here). We pick the locale from `app.getLocale()`.
 */

import {
  app,
  Tray,
  Menu,
  nativeImage,
  type NativeImage,
} from 'electron';
import { pickTrayLang, trayLabels } from './trayLabels.js';
// Bundled by electron-vite (`?asset`) and copied into out/ — the same app icon
// the window/taskbar and notifications use. We only ship a colored 256×256 PNG
// (build/icon.png); there's no dedicated monochrome tray/template asset, so the
// tray reuses it (downscaled below).
import appIcon from '../../build/icon.png?asset';

export interface TrayDeps {
  /** Restore (un-minimize), show (un-hide from tray) and focus the main window. */
  showWindow: () => void;
  /** Flag a real quit and tear the app down (bypasses the close-to-tray guard). */
  quit: () => void;
}

/** Hold a reference so the tray isn't garbage-collected and vanishes. */
let tray: Tray | null = null;

/**
 * Build the tray bitmap from the app icon. The OS tray slot is tiny (~16px on
 * Windows/Linux, ~18px on the macOS menu bar); we downscale the 256px source
 * ourselves so it renders crisp instead of letting the OS shrink the full-size
 * bitmap. We deliberately do NOT mark it as a macOS template image: the source
 * is a colored logo, and `setTemplateImage` would flatten it to a black
 * silhouette.
 */
function buildTrayIcon(): NativeImage {
  const source = nativeImage.createFromPath(appIcon);
  if (source.isEmpty()) return source; // defensive: missing asset → let Tray no-op
  const size = process.platform === 'darwin' ? 18 : 16;
  return source.resize({ width: size, height: size });
}

/**
 * Create the system tray (idempotent — a second call returns the existing one).
 * Double-click restores the window; the right-click menu offers Open and Quit.
 */
export function createTray(deps: TrayDeps): Tray {
  if (tray) return tray;

  const labels = trayLabels(pickTrayLang(app.getLocale()));
  tray = new Tray(buildTrayIcon());
  tray.setToolTip(labels.tooltip);

  const menu = Menu.buildFromTemplate([
    { label: labels.open, click: () => deps.showWindow() },
    { type: 'separator' },
    { label: labels.quit, click: () => deps.quit() },
  ]);
  tray.setContextMenu(menu);

  // Double-click is the conventional "reopen" gesture on Windows/Linux; it also
  // works on macOS (where a single click pops the context menu).
  tray.on('double-click', () => deps.showWindow());

  return tray;
}

/** Remove the tray icon. Safe to call when no tray exists. */
export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
