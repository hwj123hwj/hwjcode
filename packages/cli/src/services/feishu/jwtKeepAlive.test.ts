/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  performJwtKeepAlive,
  FEISHU_JWT_KEEPALIVE_INTERVAL_MS,
} from './jwtKeepAlive.js';

describe('FEISHU_JWT_KEEPALIVE_INTERVAL_MS', () => {
  it('is comfortably shorter than the 3-day near-expiry refresh window', () => {
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    expect(FEISHU_JWT_KEEPALIVE_INTERVAL_MS).toBeGreaterThan(0);
    // Must fire many times inside the 3-day window so an idle bot always
    // refreshes before the token actually expires.
    expect(FEISHU_JWT_KEEPALIVE_INTERVAL_MS).toBeLessThan(THREE_DAYS_MS / 4);
  });
});

describe('performJwtKeepAlive', () => {
  it('returns true when a token is obtained', async () => {
    const getToken = vi.fn().mockResolvedValue('a-valid-token');
    const ok = await performJwtKeepAlive(getToken);
    expect(ok).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('returns false (without throwing) when no token is available', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const log = vi.fn();
    const ok = await performJwtKeepAlive(getToken, log);
    expect(ok).toBe(false);
    expect(log).toHaveBeenCalled();
  });

  it('swallows errors so the keep-alive timer never crashes', async () => {
    const getToken = vi.fn().mockRejectedValue(new Error('network down'));
    const log = vi.fn();
    // Must NOT reject.
    const ok = await performJwtKeepAlive(getToken, log);
    expect(ok).toBe(false);
    expect(log).toHaveBeenCalled();
    // The error message should be surfaced to the log for diagnostics.
    expect(log.mock.calls.some((c) => String(c[0]).includes('network down'))).toBe(
      true,
    );
  });

  it('does not throw even when log itself is omitted on error path', async () => {
    const getToken = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(performJwtKeepAlive(getToken)).resolves.toBe(false);
  });
});
