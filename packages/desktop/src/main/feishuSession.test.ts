/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isFeishuGatewaySession } from './feishuSession.js';

describe('isFeishuGatewaySession', () => {
  it('matches when the record id carries the feishu- prefix', () => {
    expect(isFeishuGatewaySession({ id: 'feishu-oc_abcd1234-1700000000' })).toBe(true);
  });

  it('matches when only the acpSessionId carries the feishu- prefix', () => {
    expect(
      isFeishuGatewaySession({
        id: 'a61a53e6-6593-44f6-9673-b0c25b230b51',
        acpSessionId: 'feishu-oc_abcd1234-1700000000',
      }),
    ).toBe(true);
  });

  it('does not match a normal desktop session (UUID id + UUID acpSessionId)', () => {
    expect(
      isFeishuGatewaySession({
        id: '407fabbf-f3f1-4bdb-87ce-63b4e40563bc',
        acpSessionId: '8bff4afb-1895-4838-9321-ef79df895f2a',
      }),
    ).toBe(false);
  });

  it('does not match a normal chat where the user merely ran a /feishu command', () => {
    // The title may mention feishu, but the id/acpSessionId are still UUIDs.
    expect(
      isFeishuGatewaySession({
        id: '87a9e3a8-a9c0-4ec5-a6bf-c02878aa6c3f',
        acpSessionId: '3a7ed88f-3a3e-4bce-8ba8-e84286be1000',
      }),
    ).toBe(false);
  });

  it('does not match on a substring — the prefix must be at the start', () => {
    expect(isFeishuGatewaySession({ id: 'chat-feishu-oc_x' })).toBe(false);
  });

  it('handles missing fields', () => {
    expect(isFeishuGatewaySession({})).toBe(false);
    expect(isFeishuGatewaySession({ id: undefined, acpSessionId: undefined })).toBe(false);
  });
});
