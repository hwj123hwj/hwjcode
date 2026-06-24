/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * A small always-on-top, click-through banner shown while the agent is
 * controlling the real desktop — so the user always SEES that automation is
 * happening, even when the Easy Code window is hidden behind the app being
 * driven (mirrors Codex's on-screen indicator). It is purely informational; the
 * Stop control lives in the main window's banner and the tray, so the overlay
 * needs no preload, no IPC, and no focus (it never steals input from the app the
 * agent is operating).
 */

import { BrowserWindow, screen } from 'electron';

const BANNER_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    font-family:-apple-system,Segoe UI,Roboto,sans-serif;-webkit-user-select:none;cursor:default}
  .pill{display:flex;align-items:center;gap:8px;height:30px;padding:0 14px;margin:6px auto 0;
    width:max-content;border-radius:16px;background:rgba(190,40,40,.96);color:#fff;
    font-size:12.5px;font-weight:600;box-shadow:0 2px 12px rgba(0,0,0,.35)}
  .dot{width:9px;height:9px;border-radius:50%;background:#fff;animation:b 1.1s infinite}
  @keyframes b{0%,100%{opacity:1}50%{opacity:.25}}
</style></head><body>
  <div class="pill"><span class="dot"></span>Easy Code is controlling your computer · Stop it in the Easy Code window</div>
</body></html>`;

let overlay: BrowserWindow | null = null;

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const primary = screen.getPrimaryDisplay();
  const width = Math.min(640, primary.workAreaSize.width);
  overlay = new BrowserWindow({
    width,
    height: 44,
    x: primary.workArea.x + Math.round((primary.workAreaSize.width - width) / 2),
    y: primary.workArea.y + 6,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    // Static, app-authored content via data URL — no Node, no remote content.
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Let clicks pass through to whatever the agent is operating underneath.
  overlay.setIgnoreMouseEvents(true);
  void overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(BANNER_HTML));
  return overlay;
}

/** Show or hide the overlay to match whether the agent is actively in control. */
export function setOverlayVisible(visible: boolean): void {
  if (!visible) {
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    return;
  }
  const win = ensureOverlay();
  if (!win.isVisible()) win.showInactive();
}

export function destroyOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
}
