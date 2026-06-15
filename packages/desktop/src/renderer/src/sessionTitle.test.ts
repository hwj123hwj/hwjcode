/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  deriveTitleFromMessage,
  stripImageHints,
  PROVISIONAL_TITLE_MAX,
} from './sessionTitle';

describe('stripImageHints', () => {
  it('removes [IMAGE: ...] hints and trims', () => {
    expect(stripImageHints('hello\n[IMAGE: a.png (/tmp/a.png)]')).toBe('hello');
  });

  it('leaves plain text untouched (just trimmed)', () => {
    expect(stripImageHints('  hi there  ')).toBe('hi there');
  });
});

describe('deriveTitleFromMessage', () => {
  it('returns short messages verbatim', () => {
    expect(deriveTitleFromMessage('Fix the login bug')).toBe('Fix the login bug');
  });

  it('collapses internal whitespace/newlines to single spaces', () => {
    expect(deriveTitleFromMessage('hello\n\n  world\tagain')).toBe('hello world again');
  });

  it('truncates long messages with an ellipsis at the max length', () => {
    const long = 'a'.repeat(PROVISIONAL_TITLE_MAX + 10);
    const out = deriveTitleFromMessage(long);
    expect(out).toBe('a'.repeat(PROVISIONAL_TITLE_MAX) + '…');
    // The ellipsis is one extra char beyond the cut.
    expect(out.length).toBe(PROVISIONAL_TITLE_MAX + 1);
  });

  it('keeps a message exactly at the max length without ellipsis', () => {
    const exact = 'b'.repeat(PROVISIONAL_TITLE_MAX);
    expect(deriveTitleFromMessage(exact)).toBe(exact);
  });

  it('strips image hints before deriving the title', () => {
    expect(deriveTitleFromMessage('看看这个 [IMAGE: shot.png (/x/shot.png)]')).toBe('看看这个');
  });

  it('returns empty string when there is nothing usable', () => {
    expect(deriveTitleFromMessage('   \n  ')).toBe('');
    expect(deriveTitleFromMessage('[IMAGE: a.png (/tmp/a.png)]')).toBe('');
  });

  it('handles CJK text (counts characters, not bytes)', () => {
    const cjk = '你'.repeat(PROVISIONAL_TITLE_MAX + 5);
    const out = deriveTitleFromMessage(cjk);
    expect(out).toBe('你'.repeat(PROVISIONAL_TITLE_MAX) + '…');
  });
});
