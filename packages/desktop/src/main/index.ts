/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Electron main entry: app lifecycle + the single main window, with the typed
 * IPC bridge and ACP session hub wired in.
 */

import { app, BrowserWindow, Menu, shell, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import type { SessionHub } from './sessionHub.js';
import type { FeishuManager } from './feishu.js';
// Bundled by electron-vite (`?asset`) and copied into out/. Used as the window /
// taskbar icon at runtime (dev + Linux/Windows). On macOS the dock icon comes
// from the packaged .app bundle, so this is harmless there.
import appIcon from '../../build/icon.png?asset';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let hub: SessionHub | null = null;
let feishu: FeishuManager | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1e' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

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

app.whenReady().then(() => {
  app.setName('Easy Code');
  // Windows shows toast notifications under this AppUserModelID; without it the
  // turn-complete notifications either don't appear or show as an unbranded
  // "electron.app.…" sender. Must match electron-builder.yml's `appId`.
  if (process.platform === 'win32') app.setAppUserModelId('ai.deepvlab.easycode.desktop');
  // Drop the default application menu on Windows/Linux entirely. On macOS we
  // keep it so standard shortcuts (copy/paste/quit) and the app menu survive.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  ({ hub, feishu } = registerIpc(() => mainWindow));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  hub?.disposeAll();
  // Tear down the desktop-managed Feishu gateway so we never leave an orphan
  // gateway behind (which the next launch would otherwise detect + kill).
  feishu?.dispose();
});
