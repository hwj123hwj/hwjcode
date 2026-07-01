/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { stripSystemReminders } from './stripSystemReminders';

describe('stripSystemReminders', () => {
  it('removes a single inline reminder block, keeping surrounding text', () => {
    const input = 'Fix the bug.<system-reminder>hidden nudge</system-reminder>';
    expect(stripSystemReminders(input)).toBe('Fix the bug.');
  });

  it('removes a multiline reminder block', () => {
    const input = [
      'Please continue.',
      '',
      '<system-reminder>',
      'You have not updated the task list recently.',
      'Call todo_write before continuing.',
      '</system-reminder>',
    ].join('\n');
    expect(stripSystemReminders(input)).toBe('Please continue.');
  });

  it('removes multiple reminder blocks in one message', () => {
    const input =
      '<system-reminder>a</system-reminder>real text<system-reminder>b</system-reminder>';
    expect(stripSystemReminders(input)).toBe('real text');
  });

  it('returns empty when the message is only a reminder', () => {
    expect(stripSystemReminders('<system-reminder>only this</system-reminder>')).toBe('');
  });

  it('is case-insensitive and tolerates space/no-separator tag variants', () => {
    expect(stripSystemReminders('x<System Reminder>y</System Reminder>')).toBe('x');
    expect(stripSystemReminders('x<SYSTEM-REMINDER>y</SYSTEM-REMINDER>')).toBe('x');
    expect(stripSystemReminders('x<systemreminder>y</systemreminder>')).toBe('x');
  });

  it('collapses the blank gap left when a reminder sat between paragraphs', () => {
    const input = 'before\n\n<system-reminder>x</system-reminder>\n\nafter';
    expect(stripSystemReminders(input)).toBe('before\n\nafter');
  });

  it('leaves ordinary text untouched', () => {
    const input = 'Just a normal message with <angle> brackets & code `x < y`.';
    expect(stripSystemReminders(input)).toBe(input);
  });

  it('does not strip an unpaired opening tag (only paired blocks)', () => {
    const input = 'text <system-reminder> not closed';
    expect(stripSystemReminders(input)).toBe('text <system-reminder> not closed');
  });

  it('handles empty string', () => {
    expect(stripSystemReminders('')).toBe('');
  });
});
