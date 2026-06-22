import { describe, it, expect } from 'vitest';
import { rehabGluedSingleLineFences, escapeRawHtmlAngles } from './markdownPreprocess';

describe('rehabGluedSingleLineFences', () => {
  it('passes through plain text', () => {
    expect(rehabGluedSingleLineFences('hello world')).toBe('hello world');
  });

  it('passes through text without fences', () => {
    expect(rehabGluedSingleLineFences('no fences here')).toBe('no fences here');
  });

  it('rehabilitates glued bash fence', () => {
    const input = '```bashopen ios/foo```';
    const result = rehabGluedSingleLineFences(input);
    expect(result).toContain('```bash');
    expect(result).toContain('open ios/foo');
  });
});

describe('escapeRawHtmlAngles', () => {
  it('passes through text without angle brackets', () => {
    expect(escapeRawHtmlAngles('hello world')).toBe('hello world');
  });

  it('passes through empty string', () => {
    expect(escapeRawHtmlAngles('')).toBe('');
  });

  it('escapes angle brackets in plain text', () => {
    expect(escapeRawHtmlAngles('key:<sessionScope>')).toBe('key:&lt;sessionScope>');
  });

  it('escapes multiple angle bracket pairs', () => {
    expect(escapeRawHtmlAngles('use <T> and <U>')).toBe('use &lt;T> and &lt;U>');
  });

  it('does NOT escape angle brackets inside fenced code blocks', () => {
    const input = '```html\n<div>content</div>\n```';
    const result = escapeRawHtmlAngles(input);
    expect(result).toBe(input); // unchanged
  });

  it('does NOT escape angle brackets inside inline code spans', () => {
    const input = 'use `<Component>` for JSX';
    const result = escapeRawHtmlAngles(input);
    expect(result).toBe(input); // unchanged
  });

  it('escapes angle brackets in text but not in code blocks', () => {
    const input = 'see <sessionScope> in ```html\n<div>\n```';
    const result = escapeRawHtmlAngles(input);
    expect(result).toContain('&lt;sessionScope>');
    expect(result).toContain('<div>'); // preserved in code block
  });

  it('escapes <think>-like tags (they should have been parsed already)', () => {
    expect(escapeRawHtmlAngles('<custom>')).toBe('&lt;custom>');
  });

  it('preserves > characters (needed for blockquotes)', () => {
    expect(escapeRawHtmlAngles('> quote')).toBe('> quote');
  });

  it('handles mixed code blocks and text with angle brackets', () => {
    const input = 'The key is `xunxiashi:skillCreatorAI:sessionModel:<sessionScope>`\n\nPlain text <other>';
    const result = escapeRawHtmlAngles(input);
    // Inline code span should be preserved
    expect(result).toContain('`xunxiashi:skillCreatorAI:sessionModel:<sessionScope>`');
    // Plain text angle bracket should be escaped
    expect(result).toContain('&lt;other>');
  });
});
