/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { feishuCommand } from './feishuCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import * as credentials from '../../services/feishu/credentials.js';

vi.mock('../../services/feishu/credentials.js', () => {
  return {
    loadCredentials: vi.fn(),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    isSenderAuthorized: vi.fn(() => true),
    CredentialsLoadError: class extends Error {},
  };
});

vi.mock('../../services/feishu/gateway.js', () => {
  return {
    FeishuGateway: vi.fn().mockImplementation(() => {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        sendMessage: vi.fn(),
        sendMarkdown: vi.fn(),
        updateMessageMarkdown: vi.fn(),
      };
    }),
  };
});

describe('feishuCommand', () => {
  let context: any;

  beforeEach(() => {
    context = createMockCommandContext();
    vi.clearAllMocks();
  });

  it('should have correct metadata', () => {
    expect(feishuCommand.name).toBe('feishu');
    expect(feishuCommand.altNames).toContain('飞书');
    expect(feishuCommand.subCommands).toBeDefined();
  });

  it('should show help text', async () => {
    const helpCmd = feishuCommand.subCommands?.find(c => c.name === 'help');
    expect(helpCmd).toBeDefined();

    const result = await helpCmd?.action!(context, '');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/feishu/i);
  });

  it('should handle stop when not running', async () => {
    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    expect(stopCmd).toBeDefined();

    const result = await stopCmd?.action!(context, '');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/not running|未运行/i);
  });

  it('should handle status when credentials are missing', async () => {
    vi.mocked(credentials.loadCredentials).mockResolvedValue(null);
    const statusCmd = feishuCommand.subCommands?.find(c => c.name === 'status');
    expect(statusCmd).toBeDefined();

    const result = await statusCmd?.action!(context, '');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/not configured|未配置/i);
  });

  it('should allow adding open_id to allowlist', async () => {
    const mockCreds: any = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const allowCmd = feishuCommand.subCommands?.find(c => c.name === 'allow');
    expect(allowCmd).toBeDefined();

    const result = await allowCmd?.action!(context, 'ou_test_user');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/Added|成功加入/i);
    expect(credentials.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({
      allowlist: ['ou_test_user'],
    }));
  });

  it('should deny and remove open_id from allowlist', async () => {
    const mockCreds: any = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      ownerOpenId: 'ou_owner',
      allowlist: ['ou_test_user'],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const denyCmd = feishuCommand.subCommands?.find(c => c.name === 'deny');
    expect(denyCmd).toBeDefined();

    const result = await denyCmd?.action!(context, 'ou_test_user');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/Removed|已移除/i);
    expect(credentials.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({
      allowlist: [],
    }));
  });

  it('should handle stop correctly and reset state', async () => {
    const mockCreds: any = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const startCmd = feishuCommand.subCommands?.find(c => c.name === 'start');
    await startCmd?.action!(context, '');

    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    const stopResult = await stopCmd?.action!(context, '');
    expect(stopResult?.type).toBe('message');
    expect(stopResult?.content).toMatch(/stopped|停止|🛑/i);
  });

  it('should emit FeishuBotProcessingEnd when stopping feishu bot', async () => {
    const mockCreds: any = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const startCmd = feishuCommand.subCommands?.find(c => c.name === 'start');
    await startCmd?.action!(context, '');

    const { appEvents, AppEvent } = await import('../../utils/events.js');
    const endSpy = vi.fn();
    appEvents.on(AppEvent.FeishuBotProcessingEnd, endSpy);

    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    await stopCmd?.action!(context, '');

    appEvents.off(AppEvent.FeishuBotProcessingEnd, endSpy);
  });
});