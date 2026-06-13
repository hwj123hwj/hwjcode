/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { feishuToolEmoji, FALLBACK_TOOL_EMOJI } from './toolEmoji.js';

describe('feishuToolEmoji', () => {
  it('maps every ACP ToolKind to its palette emoji', () => {
    expect(feishuToolEmoji({ kind: 'read' })).toBe('📖');
    expect(feishuToolEmoji({ kind: 'edit' })).toBe('✏️');
    expect(feishuToolEmoji({ kind: 'delete' })).toBe('🗑️');
    expect(feishuToolEmoji({ kind: 'move' })).toBe('📦');
    expect(feishuToolEmoji({ kind: 'search' })).toBe('🔍');
    expect(feishuToolEmoji({ kind: 'execute' })).toBe('⚡');
    expect(feishuToolEmoji({ kind: 'think' })).toBe('💭');
    expect(feishuToolEmoji({ kind: 'fetch' })).toBe('🌐');
    expect(feishuToolEmoji({ kind: 'switch_mode' })).toBe('🔄');
    expect(feishuToolEmoji({ kind: 'other' })).toBe(FALLBACK_TOOL_EMOJI);
  });

  it('prefers kind over name when both are present', () => {
    // name would infer ⚡ (bash), but the authoritative kind wins.
    expect(feishuToolEmoji({ kind: 'read', name: 'Bash: npm test' })).toBe('📖');
  });

  it('maps canonical tool ids by name', () => {
    expect(feishuToolEmoji({ name: 'run_shell_command' })).toBe('⚡');
    expect(feishuToolEmoji({ name: 'read_file' })).toBe('📖');
    expect(feishuToolEmoji({ name: 'write_file' })).toBe('📝');
    expect(feishuToolEmoji({ name: 'replace' })).toBe('✏️');
    expect(feishuToolEmoji({ name: 'search_file_content' })).toBe('🔍');
    expect(feishuToolEmoji({ name: 'web_fetch' })).toBe('🌐');
    expect(feishuToolEmoji({ name: 'task' })).toBe('🤖');
    expect(feishuToolEmoji({ name: 'delegate_to_agent' })).toBe('🤝');
  });

  it('maps short names (case-insensitive)', () => {
    expect(feishuToolEmoji({ name: 'Bash' })).toBe('⚡');
    expect(feishuToolEmoji({ name: 'Grep' })).toBe('🔍');
    expect(feishuToolEmoji({ name: 'WriteFile' })).toBe('📝');
  });

  it('infers from the leading word of a free-form title', () => {
    expect(feishuToolEmoji({ name: 'Bash: npm test' })).toBe('⚡');
    expect(feishuToolEmoji({ name: 'Edit src/foo.ts' })).toBe('✏️');
    expect(feishuToolEmoji({ name: 'Read README.md' })).toBe('📖');
    expect(feishuToolEmoji({ name: 'Fetch https://example.com' })).toBe('🌐');
  });

  it('falls back to 🔧 for unknown / empty input', () => {
    expect(feishuToolEmoji({})).toBe(FALLBACK_TOOL_EMOJI);
    expect(feishuToolEmoji({ name: '' })).toBe(FALLBACK_TOOL_EMOJI);
    expect(feishuToolEmoji({ name: 'SomethingNovel' })).toBe(FALLBACK_TOOL_EMOJI);
    expect(feishuToolEmoji({ kind: 'unknown_kind' })).toBe(FALLBACK_TOOL_EMOJI);
  });
});
