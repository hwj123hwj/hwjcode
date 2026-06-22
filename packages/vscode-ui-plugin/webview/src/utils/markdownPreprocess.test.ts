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

  // --- ReDoS / catastrophic-backtracking regression guards ---
  //
  // A previous regex-based implementation went exponential while streaming an
  // unclosed code fence, freezing the entire VS Code webview. These guards
  // ensure the scanner stays linear and never hangs on pathological input.

  it('does not hang on an unclosed inline-code span full of < (streaming)', () => {
    const input = '`' + 'a<'.repeat(50000);
    const t0 = Date.now();
    const result = escapeRawHtmlAngles(input);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    // Unclosed code while streaming: treated as code, angles left verbatim.
    expect(result).toBe(input);
  });

  it('does not hang on an unclosed fenced code block full of < (streaming)', () => {
    const input = '```js\n' + 'x<'.repeat(50000);
    const t0 = Date.now();
    const result = escapeRawHtmlAngles(input);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toBe(input);
  });

  it('does not hang on long prose with many < and scattered backticks', () => {
    const input = ('<a> `b` ').repeat(50000);
    const t0 = Date.now();
    const result = escapeRawHtmlAngles(input);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    // Prose angles escaped, inline code `b` preserved.
    expect(result).toContain('&lt;a>');
    expect(result).toContain('`b`');
  });

  it('closes a streaming fence correctly once the closing fence arrives', () => {
    const input = 'before <x>\n```js\n<div>\n```\nafter <y>';
    const result = escapeRawHtmlAngles(input);
    expect(result).toContain('before &lt;x>');
    expect(result).toContain('<div>'); // inside fence: verbatim
    expect(result).toContain('after &lt;y>');
  });
});

