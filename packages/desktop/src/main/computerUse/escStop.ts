/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Global "Esc to stop" hotkey for computer use. While the agent is controlling
 * the desktop the user can press Esc — anywhere, in any app — to immediately
 * abort. The on-screen overlay advertises this (see overlay.ts).
 *
 * A global Escape hotkey is eaten by the OS before it reaches the focused app,
 * which would also swallow the synthetic Escape the AGENT itself presses. So the
 * executor wraps its own Escape key-presses in {@link withEscPassthrough}, which
 * briefly releases the hotkey so that keystroke lands on the target app instead
 * of triggering a stop.
 */

import { globalShortcut } from 'electron';

let onStop: (() => void) | null = null;
let armed = false;

function register(): boolean {
  return globalShortcut.register('Escape', () => onStop?.());
}

/** Arm the global Esc-to-stop hotkey. Idempotent; safe to call on every status. */
export function armEscStop(stop: () => void): void {
  onStop = stop;
  if (!armed) armed = register();
}

/** Release the hotkey and forget the stop callback. */
export function disarmEscStop(): void {
  if (armed) globalShortcut.unregister('Escape');
  armed = false;
  onStop = null;
}

/**
 * Run `fn` with the global Escape hotkey temporarily released, so a synthetic
 * Escape the agent presses reaches the target app instead of being captured as
 * a stop request. Re-arms afterwards if it was armed.
 */
export async function withEscPassthrough<T>(fn: () => Promise<T>): Promise<T> {
  if (!armed) return fn();
  globalShortcut.unregister('Escape');
  try {
    return await fn();
  } finally {
    armed = register();
  }
}
