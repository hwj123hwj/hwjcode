/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { pickTrayLang, trayLabels } from './trayLabels.js';

describe('pickTrayLang', () => {
  it('maps any Chinese locale variant to zh', () => {
    expect(pickTrayLang('zh')).toBe('zh');
    expect(pickTrayLang('zh-CN')).toBe('zh');
    expect(pickTrayLang('zh-Hans-CN')).toBe('zh');
    expect(pickTrayLang('ZH-TW')).toBe('zh'); // case-insensitive
  });

  it('falls back to en for non-Chinese locales', () => {
    expect(pickTrayLang('en')).toBe('en');
    expect(pickTrayLang('en-US')).toBe('en');
    expect(pickTrayLang('fr-FR')).toBe('en');
    expect(pickTrayLang('ja')).toBe('en');
  });

  it('falls back to en for empty/undefined locales', () => {
    expect(pickTrayLang('')).toBe('en');
    expect(pickTrayLang(undefined)).toBe('en');
  });
});

describe('trayLabels', () => {
  it('returns localized Open/Quit labels', () => {
    expect(trayLabels('zh')).toMatchObject({ open: '打开', quit: '退出' });
    expect(trayLabels('en')).toMatchObject({ open: 'Open', quit: 'Quit' });
  });

  it('keeps the brand name as the tooltip in both languages', () => {
    expect(trayLabels('zh').tooltip).toBe('Easy Code');
    expect(trayLabels('en').tooltip).toBe('Easy Code');
  });
});
