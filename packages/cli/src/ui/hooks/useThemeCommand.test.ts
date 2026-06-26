/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isFeishuUnattendedMode } from './useThemeCommand.js';

describe('isFeishuUnattendedMode', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('returns true when launched with --feishu (desktop-spawned / unattended gateway)', () => {
    expect(isFeishuUnattendedMode(['node', 'easycode', '--feishu'])).toBe(true);
  });

  it('returns true when --feishu appears among other flags', () => {
    expect(
      isFeishuUnattendedMode(['node', 'easycode', '--debug', '--feishu', '--foo']),
    ).toBe(true);
  });

  it('returns false for a normal interactive CLI launch', () => {
    expect(isFeishuUnattendedMode(['node', 'easycode'])).toBe(false);
  });

  it('returns false when no --feishu flag is present', () => {
    expect(isFeishuUnattendedMode(['node', 'easycode', '--debug'])).toBe(false);
  });

  it('does not match a substring like --feishu-something (must be the exact flag)', () => {
    expect(isFeishuUnattendedMode(['node', 'easycode', '--feishu-notes'])).toBe(false);
  });

  it('defaults to reading the live process.argv when no argv is passed', () => {
    process.argv = ['node', 'easycode', '--feishu'];
    expect(isFeishuUnattendedMode()).toBe(true);
    process.argv = ['node', 'easycode'];
    expect(isFeishuUnattendedMode()).toBe(false);
  });
});
