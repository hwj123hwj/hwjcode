/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * `useT()` — subscribes to the store's `lang` and returns a `t()` bound to it,
 * so any component re-renders with the new strings when the language changes.
 */

import { useStore } from '../store';
import { translate, type TranslationKey } from './i18n';

export type TFunc = (
  key: TranslationKey,
  vars?: Record<string, string | number>,
) => string;

export function useT(): TFunc {
  const lang = useStore((s) => s.lang);
  return (key, vars) => translate(lang, key, vars);
}
