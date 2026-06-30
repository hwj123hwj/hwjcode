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
  BrowserWindow,
  type NativeImage,
} from 'electron';
import path from 'node:path';
import { pickTrayLang, trayLabels } from './trayLabels.js';
import type { SessionHub } from './sessionHub.js';
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
  hub?: SessionHub;
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

function rebuildMenu(deps: TrayDeps) {
  if (!tray) return;

  const lang = pickTrayLang(app.getLocale());
  const labels = trayLabels(lang);

  const sessions = deps.hub ? deps.hub.list() : [];
  const sortedSessions = [...sessions].reverse();

  const recentCount = 5;
  const recentSessions = sortedSessions.slice(0, recentCount);
  const moreSessions = sortedSessions.slice(recentCount);

  const activeSession = sessions.find((s) => s.status !== 'dormant');
  const isRunning = activeSession !== undefined;

  const mainWin = BrowserWindow.getAllWindows()[0];
  const isWindowVisible = mainWin && mainWin.isVisible() && !mainWin.isMinimized();
  const statusLabel = isRunning
    ? (isWindowVisible ? labels.statusRunning : labels.statusBackground)
    : undefined;

  const menuItems: any[] = [];

  // 1. Current Status (if running)
  if (statusLabel) {
    menuItems.push({ label: statusLabel, enabled: false });
  }

  // 2. Current Project Name (if any active session has a cwd)
  if (activeSession && activeSession.cwd) {
    const projName = path.basename(activeSession.cwd);
    menuItems.push({
      label: labels.currentProject.replace('{name}', projName),
      enabled: false,
    });
  }

  if (statusLabel || (activeSession && activeSession.cwd)) {
    menuItems.push({ type: 'separator' });
  }

  // 3. Recent Sessions Section
  if (sessions.length > 0) {
    menuItems.push({ label: labels.recent, enabled: false });

    recentSessions.forEach((s) => {
      const projName = s.cwd ? `   (${path.basename(s.cwd)})` : '';
      menuItems.push({
        label: `${s.title}${projName}`,
        click: () => {
          deps.showWindow();
        },
      });
    });

    if (moreSessions.length > 0) {
      menuItems.push({
        label: labels.more,
        submenu: moreSessions.map((s) => {
          const projName = s.cwd ? `   (${path.basename(s.cwd)})` : '';
          return {
            label: `${s.title}${projName}`,
            click: () => {
              deps.showWindow();
            },
          };
        }),
      });
    }

    menuItems.push({ type: 'separator' });
  }

  // 4. Standard Actions
  menuItems.push({
    label: labels.newChat,
    click: () => {
      deps.showWindow();
    },
  });

  menuItems.push({ label: labels.open, click: () => deps.showWindow() });
  menuItems.push({ type: 'separator' });
  menuItems.push({ label: labels.quit, click: () => deps.quit() });

  const menu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(menu);
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

  // Initialize with the rich, dynamic menu
  rebuildMenu(deps);

  // Update menu whenever right-clicked or hovered so it stays dynamic
  tray.on('right-click', () => rebuildMenu(deps));
  tray.on('mouse-enter', () => rebuildMenu(deps));

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
