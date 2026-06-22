/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isCheetahEmail,
  highlightHintLine,
  CHEETAH_WIKI_URL,
} from './cheetahHint.js';

describe('isCheetahEmail', () => {
  it('returns false for undefined / null / empty', () => {
    expect(isCheetahEmail(undefined)).toBe(false);
    expect(isCheetahEmail(null)).toBe(false);
    expect(isCheetahEmail('')).toBe(false);
  });

  it('detects a plain @cmcm.com address', () => {
    expect(isCheetahEmail('zhangsan@cmcm.com')).toBe(true);
  });

  it('is case-insensitive on the domain', () => {
    expect(isCheetahEmail('LiSi@CMCM.COM')).toBe(true);
    expect(isCheetahEmail('liSi@Cmcm.Com')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(isCheetahEmail('  wangwu@cmcm.com  ')).toBe(true);
  });

  it('returns false for other domains', () => {
    expect(isCheetahEmail('user@gmail.com')).toBe(false);
    expect(isCheetahEmail('user@cheetah.com')).toBe(false);
    expect(isCheetahEmail('user@cmcm.com.cn')).toBe(false);
  });

  it('does NOT match when @cmcm.com is only a substring, not the domain', () => {
    // A look-alike where cmcm.com is part of the local-part or a subdomain prefix.
    expect(isCheetahEmail('cmcm.com@evil.com')).toBe(false);
    expect(isCheetahEmail('user@notcmcm.com')).toBe(false);
  });

  it('returns false for malformed / non-email strings', () => {
    expect(isCheetahEmail('not-an-email')).toBe(false);
    expect(isCheetahEmail('@cmcm.com')).toBe(false); // no local part
  });
});

describe('highlightHintLine', () => {
  it('wraps text in ANSI color codes and always resets at the end', () => {
    const out = highlightHintLine('hello');
    expect(out).toContain('hello');
    // must reset so the color does not bleed into following lines
    expect(out.endsWith('\u001b[0m')).toBe(true);
    // must start with an ANSI escape
    expect(out.startsWith('\u001b[')).toBe(true);
  });
});

describe('CHEETAH_WIKI_URL', () => {
  it('points to the cheetah-mobile feishu wiki', () => {
    expect(CHEETAH_WIKI_URL).toContain('cheetah-mobile.feishu.cn/wiki/');
  });
});
