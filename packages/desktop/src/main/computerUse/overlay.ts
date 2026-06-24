/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * A full-screen, always-on-top, click-through overlay shown while the agent is
 * controlling the real desktop — so the user always SEES that automation is
 * happening, even when the Easy Code window is hidden behind the app being
 * driven. It paints a sci-fi blue glow hugging all four screen edges plus a
 * sleek top-center pill ("… is controlling your computer · Esc to stop").
 *
 * It also renders a big "AI cursor" sprite that follows the real pointer, so the
 * agent's actions are easy to track on screen (the OS hardware cursor still
 * composites above all windows, so the small real cursor coexists tip-aligned —
 * this is an indicator, not a replacement; truly hiding the system cursor needs
 * a native SetSystemCursor call).
 *
 * It is purely visual: the window is non-focusable and ignores the mouse, so it
 * never steals input from the app the agent is operating. Stop controls live in
 * the main-window banner, the tray, and the global Esc hotkey (see escStop.ts).
 *
 * `setContentProtection(true)` keeps the glow + pill + cursor OUT of the
 * screenshots the model sees (Windows WDA_EXCLUDEFROMCAPTURE / macOS
 * NSWindowSharingNone), so the overlay never pollutes the agent's view of the
 * screen it's driving (the model still reasons about the real hardware cursor).
 */

import { BrowserWindow, screen } from 'electron';

const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;width:100%;background:transparent;overflow:hidden;
    font-family:-apple-system,Segoe UI,Roboto,sans-serif;-webkit-user-select:none;cursor:default}
  /* Sci-fi blue light hugging the four screen edges. Layered inset glows go from
     a crisp cyan rim to a soft deep-blue bloom, breathing slowly. */
  .frame{position:fixed;inset:0;pointer-events:none;border-radius:6px;
    box-shadow:
      inset 0 0 2px 1px rgba(150,225,255,.95),
      inset 0 0 14px 1px rgba(70,180,255,.65),
      inset 0 0 46px 6px rgba(34,140,255,.42),
      inset 0 0 120px 22px rgba(18,100,230,.24),
      inset 0 0 240px 60px rgba(10,70,200,.12);
    animation:breathe 2.6s ease-in-out infinite}
  @keyframes breathe{0%,100%{opacity:.82}50%{opacity:1}}
  .pill{position:fixed;left:50%;top:14px;transform:translateX(-50%);
    display:flex;align-items:center;gap:11px;height:38px;padding:0 18px;
    border-radius:19px;white-space:nowrap;
    background:linear-gradient(180deg,rgba(20,30,48,.94),rgba(11,18,33,.94));
    border:1px solid rgba(96,186,255,.38);color:#e9f4ff;
    font-size:14px;font-weight:600;letter-spacing:.2px;
    box-shadow:0 6px 26px rgba(0,0,0,.45),0 0 20px rgba(40,150,255,.32);
    -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
  .dot{width:9px;height:9px;border-radius:50%;background:#46d3ff;
    box-shadow:0 0 9px 2px rgba(70,211,255,.9);animation:pulse 1.3s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.78)}}
  .sep{opacity:.38;margin:0 1px;font-weight:400}
  .esc{display:inline-flex;align-items:center;gap:7px;opacity:.88;font-weight:500;font-size:13px}
  kbd{display:inline-block;padding:1px 7px;border-radius:6px;
    border:1px solid rgba(150,200,255,.42);background:rgba(255,255,255,.09);
    font:600 11px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#dcecff}
  /* The big AI cursor. Tip is anchored at the sprite's (0,0), so positioning it
     at the real cursor's screen point lines the tip up exactly. Swap the inner
     <svg> for an <img src="…"> if you ever want a bitmap cursor instead. */
  #cur{position:fixed;left:0;top:0;width:30px;height:auto;pointer-events:none;
    transform:translate(-200px,-200px);will-change:transform;
    transition:transform .03s linear;
    filter:drop-shadow(0 2px 3px rgba(0,0,0,.5)) drop-shadow(0 0 5px rgba(60,180,255,.55))}
  #cur svg{display:block;width:100%;height:auto}
</style></head><body>
  <div class="frame"></div>
  <div class="pill">
    <span class="dot"></span>
    <span class="title">Easy Code is controlling your computer</span>
    <span class="sep">·</span>
    <span class="esc"><kbd>Esc</kbd> to stop</span>
  </div>
  <div id="cur"><svg viewBox="0 0 17 27" xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L0 24 L6 18.5 L9.6 26.5 L13 25 L9.4 17.2 L16.5 17.2 Z" fill="#fff" stroke="#0b0f1a" stroke-width="1.25" stroke-linejoin="round"/></svg></div>
  <script>window.__cur=function(x,y){var c=document.getElementById('cur');if(c)c.style.transform='translate('+x+'px,'+y+'px)';};</script>
</body></html>`;

let overlay: BrowserWindow | null = null;
let cursorTimer: ReturnType<typeof setInterval> | null = null;
let pushInFlight = false;

/**
 * Poll the real cursor position (~60fps) and drive the overlay's big cursor to
 * match. We read the OS cursor rather than the agent's intended target so the
 * sprite tracks live during drags/moves too. Coordinates are DIP, which equal
 * the overlay's CSS pixels, so this is DPI-independent.
 */
function startCursorTracking(win: BrowserWindow): void {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    // Self-throttle: skip a tick if the previous push hasn't round-tripped yet.
    if (pushInFlight || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = screen.getPrimaryDisplay().bounds;
    const x = p.x - b.x;
    const y = p.y - b.y;
    pushInFlight = true;
    win.webContents
      .executeJavaScript(`window.__cur&&window.__cur(${x},${y})`, true)
      .catch(() => undefined)
      .finally(() => {
        pushInFlight = false;
      });
  }, 16);
}

function stopCursorTracking(): void {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
  pushInFlight = false;
}

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
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
  // Keep the glow + pill out of the model's screenshots (excluded from capture).
  overlay.setContentProtection(true);
  void overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML));
  return overlay;
}

/** Show or hide the overlay to match whether the agent is actively in control. */
export function setOverlayVisible(visible: boolean): void {
  if (!visible) {
    stopCursorTracking();
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    return;
  }
  const win = ensureOverlay();
  // Re-snap to the current primary display in case resolution/layout changed
  // since the window was created.
  const { bounds } = screen.getPrimaryDisplay();
  win.setBounds(bounds);
  if (!win.isVisible()) win.showInactive();
  startCursorTracking(win);
}

export function destroyOverlay(): void {
  stopCursorTracking();
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
}
