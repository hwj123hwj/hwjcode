/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Localized tray-menu labels, kept separate from `tray.ts` so this pure logic
 * is unit-testable without pulling in `electron` or the `?asset` icon import.
 *
 * The tray runs in the MAIN process, where the renderer's i18n catalog isn't
 * reachable (it lives behind contextIsolation and resolves the UI language from
 * `localStorage`). Rather than share the full catalog for two strings, we keep
 * this tiny independent map and pick the locale from `app.getLocale()` — the
 * same OS signal the renderer falls back to via its `detectSystemLang`.
 */

export type TrayLang = 'zh' | 'en';

export interface TrayLabels {
  open: string;
  quit: string;
  tooltip: string;
}

/** The full label set per supported tray language. Tooltip stays the brand name. */
const LABELS: Record<TrayLang, TrayLabels> = {
  zh: { open: '打开', quit: '退出', tooltip: 'Easy Code' },
  en: { open: 'Open', quit: 'Quit', tooltip: 'Easy Code' },
};

/**
 * Map an OS / BCP-47 locale string (e.g. "zh-CN", "en-US") onto one of our two
 * supported tray languages. Mirrors the renderer's `detectSystemLang` heuristic
 * so the tray and UI agree on language when neither has an explicit override.
 */
export function pickTrayLang(locale: string | undefined): TrayLang {
  return (locale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Localized tray labels for the given language. */
export function trayLabels(lang: TrayLang): TrayLabels {
  return LABELS[lang];
}
