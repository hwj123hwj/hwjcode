/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Electron main entry: app lifecycle + the single main window, with the typed
 * IPC bridge and ACP session hub wired in.
 */

import { app, BrowserWindow, Menu, shell, nativeTheme, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import { ensurePathFromLoginShell } from './shellPath.js';
import { createTray, destroyTray } from './tray.js';
import { IpcEvent } from '../shared/ipc.js';
import { destroyOverlay } from './computerUse/overlay.js';
import type { SessionHub } from './sessionHub.js';
import type { FeishuManager } from './feishu.js';
import type { UpdateManager } from './updater.js';
import type { TerminalManager } from './terminals.js';
import type { ComputerUseManager } from './computerUse/index.js';
// Bundled by electron-vite (`?asset`) and copied into out/. Used as the window /
// taskbar icon at runtime (dev + Linux/Windows), and — via app.dock.setIcon in
// bootstrap() — as the macOS dock icon for unpackaged/dev runs (a packaged .app
// gets its dock icon from the bundle's icns; setting it again is harmless).
import appIcon from '../../build/icon.png?asset';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let hub: SessionHub | null = null;
let feishu: FeishuManager | null = null;
let updater: UpdateManager | null = null;
let terminals: TerminalManager | null = null;
let computerUse: ComputerUseManager | null = null;

// Distinguishes "user clicked X / Cmd+W" (→ hide to tray) from "the app is
// really quitting" (→ let the window close). Set true by the only paths that
// should actually exit: the tray Quit item, and `before-quit` (which fires for
// Cmd+Q, the updater's `app.quit()` on restart, etc.).
let isQuitting = false;

/**
 * Bring the main window to the foreground from any state: recreate it if it was
 * destroyed, restore it if minimized, show it if hidden to the tray, then focus.
 * Used by the tray, the second-instance handler, and macOS dock activation.
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/**
 * Push an event to the renderer. If the window was just (re)created and its page
 * is still loading, defer the send until `did-finish-load` so the intent isn't
 * dropped before the renderer has wired up its IPC listeners. (In the normal
 * tray case the window is only hidden, not destroyed, so it sends immediately.)
 */
function sendToRenderer(channel: string, payload?: unknown): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => {
      if (!wc.isDestroyed()) wc.send(channel, payload);
    });
  } else {
    wc.send(channel, payload);
  }
}

/**
 * Tray "session" click: surface the window, then ask the renderer to bring that
 * session to the front (the renderer resumes its backend if it isn't live).
 * Showing the window alone would leave the previously-active session on screen.
 */
function focusSessionFromTray(sessionId: string): void {
  showMainWindow();
  sendToRenderer(IpcEvent.SessionFocusRequest, sessionId);
}

/** Tray "New Chat" click: surface the window, then ask the renderer to start one. */
function newChatFromTray(): void {
  showMainWindow();
  sendToRenderer(IpcEvent.NewChatRequest, undefined);
}

/** Flag a real quit so the window's close handler lets it through, then exit. */
function quitApp(): void {
  isQuitting = true;
  app.quit();
}

/**
 * macOS application menu. The first submenu's title is the app name shown in the
 * menu bar; building it explicitly guarantees "Easy Code" instead of the default
 * "Electron". Includes the standard Edit/Window items so copy/paste/quit and the
 * usual shortcuts keep working.
 */
function setMacAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Easy Code',
      submenu: [
        { role: 'about', label: 'About Easy Code' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Easy Code' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Easy Code' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1F1F1E' : '#F8F8F6',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : (process.platform === 'win32' ? 'hidden' : 'default'),
    titleBarOverlay: process.platform === 'win32' ? {
      color: nativeTheme.shouldUseDarkColors ? '#1F1F1E' : '#F8F8F6',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#C2C1B6' : '#202124',
      height: 36,
    } : undefined,
    title: 'Easy Code',
    icon: appIcon,
    // The traditional File/Edit/View/Window/Help menu bar is meaningless for
    // Easy Code — keep it hidden (and Alt won't reveal it since it's removed
    // entirely on Windows/Linux below).
    autoHideMenuBar: true,
    webPreferences: {
      // electron-vite emits the preload as ESM (.mjs) — required for an ESM
      // preload under contextIsolation with sandbox disabled.
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Enable the <webview> tag used by the built-in browser panel. The guest
      // page runs out-of-process in its own session partition (persist:browser),
      // so it can't reach Node or the easycode bridge.
      webviewTag: true,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  const handleThemeUpdate = (): void => {
    const isDark = nativeTheme.shouldUseDarkColors;
    mainWindow?.setBackgroundColor(isDark ? '#1F1F1E' : '#F8F8F6');
    if (process.platform === 'win32') {
      mainWindow?.setTitleBarOverlay({
        color: isDark ? '#1F1F1E' : '#F8F8F6',
        symbolColor: isDark ? '#C2C1B6' : '#202124',
        height: 36,
      });
    }
  };
  nativeTheme.on('updated', handleThemeUpdate);
  mainWindow.on('closed', () => {
    nativeTheme.off('updated', handleThemeUpdate);
  });

  // Closing the window (X on Windows/Linux, red button / Cmd+W on macOS) hides
  // it to the tray rather than quitting — the standard "stays running in the
  // tray" desktop behavior. Only a genuine quit (tray Quit, Cmd+Q, updater
  // restart) sets `isQuitting` and is allowed to actually close the window.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // Open target=_blank / external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

// Single-instance lock: only the first launch owns the app. A second launch
// fails to get the lock, so it forwards its intent to the running instance (via
// the `second-instance` event below) and exits immediately.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // The already-running instance gets this when another launch is attempted —
  // surface its window to the foreground (it may be minimized or in the tray).
  app.on('second-instance', () => showMainWindow());
  bootstrap();
}

function bootstrap(): void {
  app.whenReady().then(() => {
    app.setName('Easy Code');
    // GUI launches on macOS/Linux (Finder/Dock/launcher) bypass the login shell
    // and inherit only a minimal PATH (e.g. /usr/bin:/bin:/usr/sbin:/sbin),
    // missing /usr/local/bin, /opt/homebrew/bin, nvm shims, etc. Restore the
    // real PATH from the login shell BEFORE registerIpc()/createWindow() so
    // external agent detection (claude/codex) and the `npx` ACP bridge spawns
    // can find their binaries. No-op on Windows.
    ensurePathFromLoginShell();
    // Windows shows toast notifications under this AppUserModelID; without it
    // the turn-complete notifications either don't appear or show as an
    // unbranded "electron.app.…" sender. Must match electron-builder.yml's
    // `appId`.
    if (process.platform === 'win32') app.setAppUserModelId('ai.deepvlab.easycode.desktop');
    if (process.platform === 'darwin') {
      // Build the app menu explicitly so its first item reads "Easy Code" — the
      // default macOS menu shows "Electron" in dev/unpackaged runs regardless
      // of app.setName. Keep the standard edit/window shortcuts working.
      setMacAppMenu();
      // Show the Easy Code logo in the dock. A packaged .app already gets its
      // dock icon from the bundle's icns, but dev/unpackaged runs (electron-vite
      // serve, `electron .`) otherwise show the generic Electron icon — so set
      // it explicitly. `app.dock` exists only on macOS; guarded above.
      const dockIcon = nativeImage.createFromPath(appIcon);
      if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
    } else {
      // Drop the default application menu on Windows/Linux entirely.
      Menu.setApplicationMenu(null);
    }
    ({ hub, feishu, updater, terminals, computerUse } = registerIpc(() => mainWindow));
    createWindow();
    // System tray: closing the window hides it here, so the tray is the way
    // back to a visible window (and to an explicit Quit).
    createTray({
      showWindow: showMainWindow,
      focusSession: focusSessionFromTray,
      newChat: newChatFromTray,
      quit: quitApp,
      hub: hub || undefined,
    });
    // Kick off the version-update lifecycle (startup check + periodic poll). It
    // delays its first check internally so it never competes with boot.
    updater.start();

    app.on('activate', () => {
      // Dock/taskbar re-activation: recreate the window if it's gone, otherwise
      // just surface the existing (possibly tray-hidden) one.
      showMainWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // This fires for every real exit path — Cmd+Q, the updater's restart
  // `app.quit()`, the tray Quit item — so it's the single place that authorizes
  // the window's close handler to actually close instead of hiding to the tray.
  isQuitting = true;
  hub?.disposeAll();
  // Tear down the desktop-managed Feishu gateway so we never leave an orphan
  // gateway behind (which the next launch would otherwise detect + kill).
  feishu?.dispose();
  // Stop the update poll timer and abort any in-flight download.
  updater?.dispose();
  // Kill any integrated-terminal shells so we never orphan a child process.
  terminals?.disposeAll();
  // Stop the computer-use MCP server + abort any in-flight on-screen action,
  // and tear down the always-on-top control overlay.
  computerUse?.dispose();
  destroyOverlay();
  // Remove the tray icon so it doesn't linger after the windows are gone.
  destroyTray();
});
