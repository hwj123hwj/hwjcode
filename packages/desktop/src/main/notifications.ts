/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Turn-complete OS notifications. When the agent finishes a turn (or errors)
 * while the window is NOT in the foreground (minimized / hidden / another app
 * focused), we surface a standard system notification so the user knows their
 * reply is ready — mirroring Codex/Claude Code desktop. Clicking it restores the
 * window and brings the originating session to the front.
 *
 * Lives in the main process because only it can construct an Electron
 * {@link Notification} and inspect the {@link BrowserWindow} focus state.
 */

import { Notification, type BrowserWindow } from 'electron';
import type { DesktopSessionEvent } from '../shared/ipc.js';
// Reuse the app icon so the toast carries our branding (Windows/Linux). On macOS
// the notification icon comes from the app bundle, so this is harmless there.
import appIcon from '../../build/icon.png?asset';

export interface NotifierDeps {
  /** The main window, or null before it's created / after it's destroyed. */
  getWindow: () => BrowserWindow | null;
  /** Resolve a session's display title for the notification heading. */
  getTitle: (sessionId: string) => string | undefined;
  /** Ask the renderer to bring this session to the foreground. */
  focusSession: (sessionId: string) => void;
}

/** Longest reply snippet we put in a notification body before eliding. */
const SNIPPET_MAX = 140;
/** Cap the per-session text buffer so a huge reply can't grow unbounded. */
const BUFFER_MAX = 4000;

export class TurnNotifier {
  /** Accumulated assistant prose for the in-flight turn, keyed by session id. */
  private readonly buffers = new Map<string, string>();

  constructor(private readonly deps: NotifierDeps) {}

  /** Feed every normalized session event through here (before/after it ships to the UI). */
  handle(sessionId: string, event: DesktopSessionEvent): void {
    switch (event.kind) {
      // A new turn (or a tool call mid-turn) starts a fresh prose buffer, so the
      // notification body reflects the FINAL answer rather than intermediate
      // chatter that preceded the last tool call.
      case 'turn_start':
      case 'user_chunk':
      case 'tool_call':
        this.buffers.set(sessionId, '');
        break;
      case 'message_chunk': {
        const prev = this.buffers.get(sessionId) ?? '';
        this.buffers.set(sessionId, (prev + event.text).slice(0, BUFFER_MAX));
        break;
      }
      case 'turn_end':
        // A cancelled turn isn't a completed reply — don't ping the user.
        if (event.stopReason !== 'cancelled') {
          this.notify(sessionId, snippet(this.buffers.get(sessionId) ?? '') || '回复完成');
        }
        this.buffers.delete(sessionId);
        break;
      case 'error':
        this.notify(sessionId, `出错：${snippet(event.message)}`);
        this.buffers.delete(sessionId);
        break;
      default:
        break;
    }
  }

  /** True when the user isn't actively looking at the window. */
  private inForeground(): boolean {
    const win = this.deps.getWindow();
    return !!win && !win.isDestroyed() && win.isFocused();
  }

  private notify(sessionId: string, body: string): void {
    // Skip when the user is already watching, or the platform has no notifications.
    if (!Notification.isSupported() || this.inForeground()) return;

    const notification = new Notification({
      title: this.deps.getTitle(sessionId) ?? 'Easy Code',
      body,
      icon: appIcon,
    });
    notification.on('click', () => {
      const win = this.deps.getWindow();
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
      }
      this.deps.focusSession(sessionId);
    });
    notification.show();
  }
}

/** Collapse whitespace and clamp to a single-line notification snippet. */
function snippet(text: string, max = SNIPPET_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
