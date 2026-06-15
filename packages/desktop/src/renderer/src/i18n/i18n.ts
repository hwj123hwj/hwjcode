/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lightweight i18n for the desktop renderer. No third-party dependency: a flat
 * key → string catalog per locale, a `t()` lookup with `{name}` interpolation,
 * and a `useT()` hook that re-renders consumers when the language changes.
 */

import { zh } from './locales/zh';
import { en } from './locales/en';

export type Lang = 'zh' | 'en';

/** Catalog shape is defined by the Chinese locale; English must match its keys. */
export type TranslationKey = keyof typeof zh;

const catalogs: Record<Lang, Record<string, string>> = { zh, en };

/** Resolve the initial language: a stored choice wins, else follow the OS. */
const STORAGE_KEY = 'easycode.lang';

export function detectSystemLang(): Lang {
  const nav =
    typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function loadStoredLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'zh' || v === 'en') return v;
  } catch {
    /* localStorage unavailable — fall through */
  }
  return detectSystemLang();
}

export function persistLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* best-effort */
  }
}

/**
 * Translate `key` for `lang`, substituting `{name}` placeholders from `vars`.
 * Falls back to the Chinese string, then to the raw key, so a missing
 * translation degrades visibly rather than crashing.
 */
export function translate(
  lang: Lang,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const template =
    catalogs[lang]?.[key] ?? catalogs.zh[key] ?? (key as string);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}
