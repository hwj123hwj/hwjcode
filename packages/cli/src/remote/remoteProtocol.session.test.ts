/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MessageFactory, MessageType } from './remoteProtocol.js';

describe('remoteProtocol CREATE_SESSION workdir support', () => {
  it('creates an empty-payload CREATE_SESSION when no workdir is given', () => {
    const message = MessageFactory.createCreateSession();
    expect(message.type).toBe(MessageType.CREATE_SESSION);
    expect(message.payload).toEqual({});
    expect(typeof message.id).toBe('string');
    expect(typeof message.timestamp).toBe('number');
  });

  it('threads the optional workdir into the CREATE_SESSION payload', () => {
    const message = MessageFactory.createCreateSession('D:\\projects\\foo');
    expect(message.type).toBe(MessageType.CREATE_SESSION);
    expect(message.payload).toEqual({ workdir: 'D:\\projects\\foo' });
  });
});

describe('remoteProtocol switch_to_session_notification', () => {
  it('builds a SWITCH_TO_SESSION_NOTIFICATION with sessionId, workdir and reason', () => {
    const message = MessageFactory.createSwitchToSessionNotification(
      'session_new_1',
      '/home/me/repo',
      'agent_requested',
    );
    expect(message.type).toBe(MessageType.SWITCH_TO_SESSION_NOTIFICATION);
    expect(message.payload).toEqual({
      sessionId: 'session_new_1',
      workdir: '/home/me/repo',
      reason: 'agent_requested',
    });
    expect(typeof message.id).toBe('string');
    expect(typeof message.timestamp).toBe('number');
  });

  it('allows omitting the reason', () => {
    const message = MessageFactory.createSwitchToSessionNotification(
      'session_new_2',
      '/tmp/x',
    );
    expect(message.payload.sessionId).toBe('session_new_2');
    expect(message.payload.workdir).toBe('/tmp/x');
    expect(message.payload.reason).toBeUndefined();
  });
});
