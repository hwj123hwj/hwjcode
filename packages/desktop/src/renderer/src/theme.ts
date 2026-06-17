/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Theme preference for the desktop renderer. The app ships dark + light palettes
 * (see `styles/index.css`); historically it only followed the OS color scheme.
 * This adds an explicit user override: 'system' keeps following the OS, while
 * 'light' / 'dark' force a palette regardless of the OS setting. The choice is a
 * renderer-only preference persisted to localStorage (mirrors the i18n language
 * preference) and applied by setting `data-theme` on <html>, which the CSS reads.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'easycode.theme';

export function loadStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'system' || v === 'light' || v === 'dark') return v;
  } catch {
    /* localStorage unavailable — fall through */
  }
  return 'system';
}

export function persistTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* best-effort */
  }
}

/**
 * Reflect the chosen mode onto <html data-theme>. In 'system' mode we still set
 * the attribute (to 'system') so the CSS `:not([data-theme='dark']):not([data-theme='light'])`
 * branch matches and the OS media query takes over.
 */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode);
}
