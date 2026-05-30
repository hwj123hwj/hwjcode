/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  feishuCommand,
  buildBoundProjectsLines,
  shortenProjectPath,
  interceptFeishuLifecycleCommand,
} from './feishuCommand.js';
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
        getChatName: vi.fn().mockResolvedValue(null),
      };
    }),
  };
});

// probeCredentials 走真实网络，测试中 mock 掉避免不稳定 & 加速。
vi.mock('../../services/feishu/registration.js', () => {
  return {
    initRegistration: vi.fn(),
    beginRegistration: vi.fn(),
    pollRegistration: vi.fn(),
    probeCredentials: vi.fn().mockResolvedValue(null),
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

  it('should include the bound-projects section when credentials exist', async () => {
    const mockCreds: any = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      domain: 'feishu',
      botName: 'StatusBot',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const statusCmd = feishuCommand.subCommands?.find(c => c.name === 'status');
    const result = await statusCmd?.action!(context, '');
    expect(result?.type).toBe('message');
    // 绑定项目段落标题应出现（无论是否已绑定项目）
    expect(result?.content).toMatch(/Bound Projects|绑定项目/i);
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

  it('should emit FeishuBotStarted with botName and platform payload', async () => {
    const mockCreds: any = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      domain: 'feishu',
      botName: 'MyTestBot',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const { appEvents, AppEvent } = await import('../../utils/events.js');
    const startedSpy = vi.fn();
    appEvents.on(AppEvent.FeishuBotStarted, startedSpy);

    const startCmd = feishuCommand.subCommands?.find(c => c.name === 'start');
    await startCmd?.action!(context, '');

    appEvents.off(AppEvent.FeishuBotStarted, startedSpy);

    expect(startedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ botName: 'MyTestBot', platform: 'feishu' }),
    );

    // cleanup running gateway
    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    await stopCmd?.action!(context, '');
  });

  it('should emit FeishuBotStarted with lark platform when domain is lark', async () => {
    const mockCreds: any = {
      appId: 'cli_456',
      appSecret: 'sec_456',
      domain: 'lark',
      botName: 'LarkBot',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const { appEvents, AppEvent } = await import('../../utils/events.js');
    const startedSpy = vi.fn();
    appEvents.on(AppEvent.FeishuBotStarted, startedSpy);

    const startCmd = feishuCommand.subCommands?.find(c => c.name === 'start');
    await startCmd?.action!(context, '');

    appEvents.off(AppEvent.FeishuBotStarted, startedSpy);

    expect(startedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ botName: 'LarkBot', platform: 'lark' }),
    );

    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    await stopCmd?.action!(context, '');
  });
});

// ---------------------------------------------------------------------------
// shortenProjectPath — 取路径末两级，跨平台
// ---------------------------------------------------------------------------

describe('shortenProjectPath', () => {
  it('keeps only the last two segments for a deep POSIX path', () => {
    expect(shortenProjectPath('/home/user/projects/easyrouter-codingplan')).toBe(
      '.../projects/easyrouter-codingplan',
    );
  });

  it('keeps only the last two segments for a Windows path', () => {
    expect(shortenProjectPath('D:\\projects\\deepVcode\\DeepCode')).toBe(
      '.../deepVcode/DeepCode',
    );
  });

  it('returns the original path when it has two or fewer segments', () => {
    expect(shortenProjectPath('/var')).toBe('/var');
    expect(shortenProjectPath('foo/bar')).toBe('foo/bar');
  });

  it('returns empty string for empty input', () => {
    expect(shortenProjectPath('')).toBe('');
    expect(shortenProjectPath(undefined as any)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildBoundProjectsLines — 绑定项目列表渲染（群名解析 + 活跃标记）
// ---------------------------------------------------------------------------

describe('buildBoundProjectsLines', () => {
  it('renders an empty-state hint when there are no routes', () => {
    const lines = buildBoundProjectsLines({});
    const joined = lines.join('\n');
    // 标题应带数量 0
    expect(joined).toMatch(/\(0\)/);
    // 应包含「暂无绑定 / No projects」提示
    expect(joined).toMatch(/No projects|暂无绑定/i);
  });

  it('lists each bound project with its chatId and shortened path', () => {
    const routes = {
      oc_aaa: { projectRoot: '/home/user/projects/app-one' },
      oc_bbb: { projectRoot: 'D:\\work\\repos\\app-two' },
    };
    const lines = buildBoundProjectsLines(routes);
    const joined = lines.join('\n');
    expect(joined).toMatch(/\(2\)/);
    expect(joined).toContain('oc_aaa');
    expect(joined).toContain('oc_bbb');
    expect(joined).toContain('.../projects/app-one');
    expect(joined).toContain('.../repos/app-two');
  });

  it('prefers resolved group names over chatId when chatNames is provided', () => {
    const routes = { oc_aaa: { projectRoot: '/p/app-one' } };
    const lines = buildBoundProjectsLines(routes, {
      chatNames: { oc_aaa: '我的协作群' },
    });
    const joined = lines.join('\n');
    expect(joined).toContain('我的协作群');
    // chatId 不再作为主显示（仍可作为补充，这里只要求群名出现且在 chatId 之前）
    expect(joined.indexOf('我的协作群')).toBeLessThan(
      joined.indexOf('oc_aaa') === -1 ? Infinity : joined.indexOf('oc_aaa'),
    );
  });

  it('falls back to chatId when a chat name is missing', () => {
    const routes = {
      oc_named: { projectRoot: '/p/one' },
      oc_unnamed: { projectRoot: '/p/two' },
    };
    const lines = buildBoundProjectsLines(routes, {
      chatNames: { oc_named: 'Named Group' },
    });
    const joined = lines.join('\n');
    expect(joined).toContain('Named Group');
    expect(joined).toContain('oc_unnamed');
  });

  it('marks the active chat with a green dot and an (Active) suffix', () => {
    const routes = {
      oc_active: { projectRoot: '/p/active' },
      oc_idle: { projectRoot: '/p/idle' },
    };
    const lines = buildBoundProjectsLines(routes, { activeChatIds: ['oc_active'] });
    const activeLine = lines.find((l) => l.includes('oc_active'));
    const idleLine = lines.find((l) => l.includes('oc_idle'));
    expect(activeLine).toBeDefined();
    expect(activeLine).toMatch(/Active|活跃/i);
    expect(activeLine).toContain('🟢');
    // 非活跃行不应带 Active 标记
    expect(idleLine).toBeDefined();
    expect(idleLine).not.toMatch(/\(Active\)|\(活跃中\)/);
  });

  it('marks ALL currently-working chats as active (multiple concurrent groups)', () => {
    const routes = {
      oc_a: { projectRoot: '/p/a' },
      oc_b: { projectRoot: '/p/b' },
      oc_c: { projectRoot: '/p/c' },
    };
    // oc_a 与 oc_c 同时在干活，oc_b 空闲
    const lines = buildBoundProjectsLines(routes, {
      activeChatIds: new Set(['oc_a', 'oc_c']),
    });
    const lineA = lines.find((l) => l.includes('oc_a'));
    const lineB = lines.find((l) => l.includes('oc_b'));
    const lineC = lines.find((l) => l.includes('oc_c'));
    expect(lineA).toMatch(/Active|活跃/i);
    expect(lineA).toContain('🟢');
    expect(lineC).toMatch(/Active|活跃/i);
    expect(lineC).toContain('🟢');
    // 空闲群不带活跃标记
    expect(lineB).not.toMatch(/\(Active\)|\(活跃中\)/);
    expect(lineB).not.toContain('🟢');
  });

  it('treats an empty active set as no active chats', () => {
    const routes = { oc_a: { projectRoot: '/p/a' } };
    const lines = buildBoundProjectsLines(routes, { activeChatIds: new Set() });
    const joined = lines.join('\n');
    expect(joined).not.toMatch(/\(Active\)|\(活跃中\)/);
    expect(joined).not.toContain('🟢');
  });

  it('handles routes that have no projectRoot gracefully', () => {
    const routes = { oc_nopath: {} };
    const lines = buildBoundProjectsLines(routes);
    const joined = lines.join('\n');
    expect(joined).toContain('oc_nopath');
    // 不应抛错，也不应出现 undefined 字样
    expect(joined).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// interceptFeishuLifecycleCommand — 飞书侧拦截 /feishu start|stop
// ---------------------------------------------------------------------------

describe('interceptFeishuLifecycleCommand', () => {
  it('intercepts /feishu stop with a friendly hint', () => {
    const hint = interceptFeishuLifecycleCommand('/feishu stop');
    expect(hint).not.toBeNull();
    expect(hint).toMatch(/stop|停止|断连|disconnect/i);
  });

  it('intercepts /feishu start with a friendly hint', () => {
    const hint = interceptFeishuLifecycleCommand('/feishu start');
    expect(hint).not.toBeNull();
    expect(hint).toMatch(/running|运行中|terminal|终端/i);
  });

  it('is case-insensitive and tolerates trailing whitespace', () => {
    expect(interceptFeishuLifecycleCommand('/FEISHU STOP  ')).not.toBeNull();
    expect(interceptFeishuLifecycleCommand('  /Feishu Start')).not.toBeNull();
  });

  it('supports the 飞书 alias', () => {
    expect(interceptFeishuLifecycleCommand('/飞书 stop')).not.toBeNull();
    expect(interceptFeishuLifecycleCommand('/飞书 start')).not.toBeNull();
  });

  it('returns null for /feishu status (must not be intercepted)', () => {
    expect(interceptFeishuLifecycleCommand('/feishu status')).toBeNull();
  });

  it('returns null for other /feishu subcommands and unrelated commands', () => {
    expect(interceptFeishuLifecycleCommand('/feishu allowlist')).toBeNull();
    expect(interceptFeishuLifecycleCommand('/feishu')).toBeNull();
    expect(interceptFeishuLifecycleCommand('/status')).toBeNull();
    expect(interceptFeishuLifecycleCommand('/stop')).toBeNull();
    expect(interceptFeishuLifecycleCommand('hello world')).toBeNull();
  });

  it('does not intercept when start/stop appear as plain words, not the subcommand', () => {
    expect(interceptFeishuLifecycleCommand('please feishu stop')).toBeNull();
    expect(interceptFeishuLifecycleCommand('/feishustop')).toBeNull();
  });
});