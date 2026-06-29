/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { shouldEnableFeishuAutoStartFallback } from './feishuAutoStart.js';

describe('shouldEnableFeishuAutoStartFallback', () => {
  it('enables fallback in self-update restart scenario (EASYCODE_STARTUP_DELAY_MS set)', () => {
    expect(
      shouldEnableFeishuAutoStartFallback({ EASYCODE_STARTUP_DELAY_MS: '3000' }),
    ).toBe(true);
  });

  it('enables fallback in desktop-managed scenario (EASYCODE_DESKTOP_MANAGED=1)', () => {
    // Desktop spawns `easycode --feishu` with stdio piped (no TTY). Ink degrades
    // its render so the state-driven auto-start effect may never fire — exactly
    // the case this fallback must cover. Desktop sets DESKTOP_MANAGED but NOT
    // STARTUP_DELAY_MS, which is why the old `STARTUP_DELAY_MS`-only guard
    // silently skipped the fallback and `/feishu start` was never issued.
    expect(
      shouldEnableFeishuAutoStartFallback({ EASYCODE_DESKTOP_MANAGED: '1' }),
    ).toBe(true);
  });

  it('enables fallback when both env markers are present', () => {
    expect(
      shouldEnableFeishuAutoStartFallback({
        EASYCODE_DESKTOP_MANAGED: '1',
        EASYCODE_STARTUP_DELAY_MS: '3000',
      }),
    ).toBe(true);
  });

  it('does NOT enable fallback for a plain interactive CLI (no markers)', () => {
    // A human running `easycode --feishu` in a real terminal has a TTY, so the
    // primary state-driven effect fires normally; the polling fallback must not
    // kick in and double-trigger.
    expect(shouldEnableFeishuAutoStartFallback({})).toBe(false);
  });

  it('treats EASYCODE_DESKTOP_MANAGED values other than "1" as not desktop-managed', () => {
    expect(
      shouldEnableFeishuAutoStartFallback({ EASYCODE_DESKTOP_MANAGED: '0' }),
    ).toBe(false);
    expect(
      shouldEnableFeishuAutoStartFallback({ EASYCODE_DESKTOP_MANAGED: '' }),
    ).toBe(false);
  });

  it('ignores an empty EASYCODE_STARTUP_DELAY_MS', () => {
    expect(
      shouldEnableFeishuAutoStartFallback({ EASYCODE_STARTUP_DELAY_MS: '' }),
    ).toBe(false);
  });
});
