/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { UnauthorizedError } from 'deepv-code-core';
import {
  isFeishuAuthError,
  buildFeishuAuthErrorMessage,
  FEISHU_AUTH_ERROR_HINT,
} from './authError.js';

describe('isFeishuAuthError', () => {
  it('returns false for null / undefined', () => {
    expect(isFeishuAuthError(null)).toBe(false);
    expect(isFeishuAuthError(undefined)).toBe(false);
  });

  it('returns false for a generic error', () => {
    expect(isFeishuAuthError(new Error('something else went wrong'))).toBe(
      false,
    );
  });

  it('detects an UnauthorizedError instance', () => {
    const err = new UnauthorizedError('Authentication required - please re-authenticate');
    expect(isFeishuAuthError(err)).toBe(true);
  });

  it('detects by error name === UnauthorizedError (cross-bundle safety)', () => {
    // Simulate a class identity mismatch after bundling: same name, plain Error.
    const err = new Error('boom');
    err.name = 'UnauthorizedError';
    expect(isFeishuAuthError(err)).toBe(true);
  });

  it('detects the raw server message "Authentication required"', () => {
    const err = new Error('Authentication required - please re-authenticate');
    expect(isFeishuAuthError(err)).toBe(true);
  });

  it('is case-insensitive on the message match', () => {
    const err = new Error('authentication required');
    expect(isFeishuAuthError(err)).toBe(true);
  });

  it('detects "please re-authenticate" phrasing', () => {
    const err = new Error('Token invalid, please re-authenticate now');
    expect(isFeishuAuthError(err)).toBe(true);
  });

  it('accepts a plain string error', () => {
    expect(isFeishuAuthError('Authentication required')).toBe(true);
    expect(isFeishuAuthError('totally fine')).toBe(false);
  });

  it('does NOT misfire on unrelated words containing "auth"', () => {
    expect(isFeishuAuthError(new Error('author list updated'))).toBe(false);
    expect(isFeishuAuthError(new Error('authorization header set'))).toBe(
      false,
    );
  });
});

describe('buildFeishuAuthErrorMessage', () => {
  it('always contains the /auth re-login hint', () => {
    const msg = buildFeishuAuthErrorMessage('Authentication required');
    expect(msg).toContain(FEISHU_AUTH_ERROR_HINT);
    expect(msg).toContain('/auth');
  });

  it('mentions that the login state has expired', () => {
    const msg = buildFeishuAuthErrorMessage('whatever');
    expect(msg).toContain('登录状态失效');
  });

  it('does NOT leak the raw English server message to the user', () => {
    const msg = buildFeishuAuthErrorMessage(
      'Authentication required - please re-authenticate',
    );
    expect(msg).not.toContain('Authentication required - please re-authenticate');
  });
});
