/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Derives an xterm.js `ITheme` from the renderer's *current* color theme so the
 * integrated terminal matches the rest of the app (light/dark and the specific
 * palette). The background / foreground / cursor / selection are pulled live from
 * the CSS custom properties on <html> (the same `--bg-sunken`, `--text`, … tokens
 * the rest of the UI uses), while the ANSI 16-colour palette comes from two
 * hand-tuned tables (dark / light) harmonised with the warm-charcoal design.
 *
 * Because it reads `getComputedStyle(document.documentElement)`, calling it after
 * the theme has been applied to <html data-theme> yields the right palette — so
 * the terminal store rebuilds + re-applies it whenever the theme changes (see
 * `terminalSession.ts`).
 */

import type { ITheme } from '@xterm/xterm';

/** Read a CSS custom property off <html>, trimmed; `fallback` if empty. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Resolve whether the *effective* theme is dark (honouring 'system' → OS). */
function isDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light') return false;
  if (attr === 'dark') return true;
  // 'system' (or unset): follow the OS preference, mirroring the CSS media query.
  return !window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** ANSI 16-colour palette for the dark palette. */
const DARK_ANSI = {
  black: '#2c2b29',
  red: '#e2776e',
  green: '#6cc28a',
  yellow: '#d6a94a',
  blue: '#74a3ef',
  magenta: '#c290e0',
  cyan: '#67b7c7',
  white: '#d8d5cc',
  brightBlack: '#6f6c64',
  brightRed: '#ef9a92',
  brightGreen: '#8fd6a6',
  brightYellow: '#e6c478',
  brightBlue: '#9cbff4',
  brightMagenta: '#d6aceb',
  brightCyan: '#8fd0dd',
  brightWhite: '#f3f1ea',
};

/** ANSI 16-colour palette for the light palette (tuned for a light background). */
const LIGHT_ANSI = {
  black: '#3b3a37',
  red: '#c2403b',
  green: '#2f8a4e',
  yellow: '#9a6f12',
  blue: '#2f6fd6',
  magenta: '#9a4bbf',
  cyan: '#2a8aa0',
  white: '#8a877e',
  brightBlack: '#6a685f',
  brightRed: '#d4564f',
  brightGreen: '#3fa862',
  brightYellow: '#b8851f',
  brightBlue: '#4d86e6',
  brightMagenta: '#b066d4',
  brightCyan: '#36a3bb',
  brightWhite: '#1f1e1c',
};

/** Build an xterm theme matching the renderer's current color theme. */
export function buildXtermTheme(): ITheme {
  const dark = isDark();
  const ansi = dark ? DARK_ANSI : LIGHT_ANSI;
  const bg = cssVar('--bg-sunken', dark ? '#1b1c1e' : '#f3f1ea');
  const fg = cssVar('--text', dark ? '#e6e4dd' : '#1f1e1c');
  const cursor = cssVar('--green', dark ? '#6cc28a' : '#2f8a4e');
  return {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: bg,
    selectionBackground: dark ? 'rgba(255,255,255,0.18)' : 'rgba(20,18,14,0.16)',
    ...ansi,
  };
}
