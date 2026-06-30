/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addCommand } from './mcpAddCommand.js';
import { CommandContext } from './types.js';
import { Config } from 'deepv-code-core';
import { LoadedSettings, SettingScope } from '../../config/settings.js';

// Mock i18n
vi.mock('../utils/i18n.js', () => {
  return {
    isChineseLocale: () => false,
    t: (key: string) => key,
    tp: (key: string) => key,
    getLocalizedToolName: (name: string) => name,
  };
});

describe('mcpAddCommand', () => {
  let mockContext: CommandContext;
  let mockConfig: Partial<Config>;
  let mockSettings: Partial<LoadedSettings>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getMcpServers: vi.fn().mockReturnValue({}),
    };

    mockSettings = {
      forScope: vi.fn().mockReturnValue({
        path: '/test/.deepv/settings.json',
        settings: { mcpServers: {} }
      }),
      setValue: vi.fn(),
    };

    mockContext = {
      services: {
        config: mockConfig as Config,
        settings: mockSettings as LoadedSettings,
        git: undefined,
        logger: {} as any,
      },
      ui: {} as any,
      session: {} as any,
    };
  });

  it('should show interactive wizard when no arguments provided', async () => {
    const result = await addCommand.action!(mockContext, '');

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('info');
    expect(result.content).toContain('mcp.wizard.title');
  });

  it('should list available templates in wizard', async () => {
    const result = await addCommand.action!(mockContext, '');

    expect(result.content).toContain('github');
    expect(result.content).toContain('sqlite');
    expect(result.content).toContain('filesystem');
    expect(result.content).toContain('search');
  });

  it('should detect template names correctly', async () => {
    const result = await addCommand.action!(mockContext, 'github');

    expect(result.type).toBe('message');
    // Should attempt to configure GitHub template
    expect(mockSettings.setValue).toHaveBeenCalled();
  });

  it('should handle custom server configuration', async () => {
    const result = await addCommand.action!(mockContext, 'my-server --command "npx @my/server"');

    expect(result.type).toBe('message');
    expect(mockSettings.setValue).toHaveBeenCalled();
  });

  it('should write MCP servers to the User (global) scope by default', async () => {
    await addCommand.action!(mockContext, 'my-server --command npx');

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'mcpServers',
      expect.objectContaining({
        'my-server': expect.objectContaining({ command: 'npx' }),
      }),
    );
  });

  it('should preserve quoted command, args, env and headers values', async () => {
    await addCommand.action!(
      mockContext,
      'tavily --command npx --args "-y" --args "tavily-mcp@latest" --env "TAVILY_API_KEY=tvly-abc def" --headers "X-Token=a b"',
    );

    expect(mockSettings.setValue).toHaveBeenCalled();
    const [, , updatedServers] = (mockSettings.setValue as any).mock.calls[0];
    const cfg = updatedServers['tavily'];

    expect(cfg.command).toBe('npx');
    expect(cfg.args).toEqual(['-y', 'tavily-mcp@latest']);
    expect(cfg.env).toEqual({ TAVILY_API_KEY: 'tvly-abc def' });
    expect(cfg.headers).toEqual({ 'X-Token': 'a b' });
  });

  it('should split a full command line passed via --command into command + args', async () => {
    await addCommand.action!(
      mockContext,
      'context7 --command "npx -y @upstash/context7-mcp --api-key ctx7-secret"',
    );

    expect(mockSettings.setValue).toHaveBeenCalled();
    const [, , updatedServers] = (mockSettings.setValue as any).mock.calls[0];
    const cfg = updatedServers['context7'];

    expect(cfg.command).toBe('npx');
    expect(cfg.args).toEqual([
      '-y',
      '@upstash/context7-mcp',
      '--api-key',
      'ctx7-secret',
    ]);
  });

  it('should split a single quoted --args value into multiple args', async () => {
    await addCommand.action!(
      mockContext,
      'context7 --command npx --args "-y @upstash/context7-mcp --api-key ctx7-secret"',
    );

    const [, , updatedServers] = (mockSettings.setValue as any).mock.calls[0];
    const cfg = updatedServers['context7'];

    expect(cfg.command).toBe('npx');
    expect(cfg.args).toEqual([
      '-y',
      '@upstash/context7-mcp',
      '--api-key',
      'ctx7-secret',
    ]);
  });

  it('should validate custom server parameters', async () => {
    const result = await addCommand.action!(mockContext, 'my-server');

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('mcp.error.missing.connection.params');
  });

  it('should prevent duplicate server names', async () => {
    // Mock existing server
    mockConfig.getMcpServers = vi.fn().mockReturnValue({
      'existing-server': {}
    });

    const result = await addCommand.action!(mockContext, 'existing-server --command "test"');

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('mcp.error.server.already.exists');
  });

  it('should provide template name completions', async () => {
    const completions = await addCommand.completion!(mockContext, 'git');

    expect(completions).toContain('github');
  });

  it('should filter completions based on partial input', async () => {
    const completions = await addCommand.completion!(mockContext, 'sql');

    expect(completions).toContain('sqlite');
    expect(completions).not.toContain('github');
  });
});