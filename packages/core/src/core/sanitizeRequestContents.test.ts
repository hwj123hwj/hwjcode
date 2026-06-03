/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { GeminiChat } from './geminiChat.js';
import { Content } from '../types/extendedContent.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { Config } from '../config/config.js';

vi.mock('../config/config.js');
vi.mock('./contentGenerator.js');

describe('GeminiChat.sanitizeRequestContents (static wrapper)', () => {
  it('应当与实例方法 fixRequestContents 行为完全一致', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'search', id: 'abc', args: {} } as any },
        ],
      },
      // 第二条 user 消息没有对应 functionResponse，fixRequestContents 应当补全 user cancel
    ];

    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-2.0-flash'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({ authType: 'oauth' }),
      getProjectRoot: vi.fn().mockReturnValue('/mock/path'),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getQuotaErrorOccurred: vi.fn().mockReturnValue(false),
      setModel: vi.fn(),
    } as unknown as Config;
    const chat = new GeminiChat(mockConfig, {} as any);
    const instanceResult = (chat as any).fixRequestContents(input);

    const staticResult = GeminiChat.sanitizeRequestContents(input);
    expect(staticResult).toEqual(instanceResult);
  });

  it('应当移除孤立的 functionResponse（无对应 functionCall 的 tool_result，对应 Bedrock 报错场景）', () => {
    // 模拟 /session select 加载到的残缺历史：
    //   - 历史首条就是 functionResponse（前置 functionCall 已被截断丢失）
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          {
            functionResponse: {
              name: 'glob',
              id: 'toolu_glob',
              response: { result: 'ok' },
            } as any,
          },
        ],
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: '继续聊天' } as any],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: '请你检查一下上面生成的MVP项目，调优一下。' } as any],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);

    // 孤立 functionResponse 应当被移除；那条 user 消息也会因 parts 为空而被清掉
    const allParts = result.flatMap(c => c.parts || []);
    const hasOrphan = allParts.some(
      p => (p as any).functionResponse && (p as any).functionResponse.id === 'toolu_glob',
    );
    expect(hasOrphan).toBe(false);

    // 后续真实对话应保留
    const lastUser = result[result.length - 1];
    expect(lastUser.role).toBe(MESSAGE_ROLES.USER);
  });

  it('当结果以 model 消息结尾时，应自动追加 user 占位避免 Bedrock prefill 错误', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: '你好' } as any],
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: '你好啊' } as any],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const last = result[result.length - 1];
    expect(last.role).toBe(MESSAGE_ROLES.USER);
  });
});
