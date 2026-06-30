/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { GeminiClient } from '../core/client.js';
import {
  GeminiEventType,
  ServerGeminiContentEvent,
  ServerGeminiStreamEvent,
  ServerGeminiToolCallRequestEvent,
} from '../core/turn.js';
import * as loggers from '../telemetry/loggers.js';
import { LoopType } from '../telemetry/types.js';
import { LoopDetectionService } from './loopDetectionService.js';

vi.mock('../telemetry/loggers.js', () => ({
  logLoopDetected: vi.fn(),
}));

const TOOL_CALL_LOOP_THRESHOLD = 10;
const CONTENT_LOOP_THRESHOLD = 20;
const CONTENT_CHUNK_SIZE = 500;

describe('LoopDetectionService', () => {
  let service: LoopDetectionService;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      getTelemetryEnabled: () => true,
      getModel: () => 'gemini-2.0-flash', // Non-preview model for regular tests
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    vi.clearAllMocks();
  });

  const createToolCallRequestEvent = (
    name: string,
    args: Record<string, unknown>,
  ): ServerGeminiToolCallRequestEvent => ({
    type: GeminiEventType.ToolCallRequest,
    value: {
      name,
      args,
      callId: 'test-id',
      isClientInitiated: false,
      prompt_id: 'test-prompt-id',
    },
  });

  const createContentEvent = (content: string): ServerGeminiContentEvent => ({
    type: GeminiEventType.Content,
    value: content,
  });

  describe('Tool Call Loop Detection', () => {
    it(`should not detect a loop for fewer than TOOL_CALL_LOOP_THRESHOLD identical calls`, () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.addAndCheck(event)).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it(`should detect a loop on the TOOL_CALL_LOOP_THRESHOLD-th identical call`, () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(event);
      }
      expect(service.addAndCheck(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should detect a loop on subsequent identical calls', () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD; i++) {
        service.addAndCheck(event);
      }
      expect(service.addAndCheck(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop for different tool calls', () => {
      const event1 = createToolCallRequestEvent('testTool', {
        param: 'value1',
      });
      const event2 = createToolCallRequestEvent('testTool', {
        param: 'value2',
      });
      const event3 = createToolCallRequestEvent('anotherTool', {
        param: 'value1',
      });

      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 2; i++) {
        expect(service.addAndCheck(event1)).toBe(false);
        expect(service.addAndCheck(event2)).toBe(false);
        expect(service.addAndCheck(event3)).toBe(false);
      }
    });

    it('should not reset tool call counter for other event types', () => {
      const toolCallEvent = createToolCallRequestEvent('testTool', {
        param: 'value',
      });
      const otherEvent = {
        type: 'thought',
      } as unknown as ServerGeminiStreamEvent;

      // Send events just below the threshold
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.addAndCheck(toolCallEvent)).toBe(false);
      }

      // Send a different event type
      expect(service.addAndCheck(otherEvent)).toBe(false);

      // Send the tool call event again, which should now trigger the loop
      expect(service.addAndCheck(toolCallEvent)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });
  });

  describe('Content Loop Detection', () => {
    const generateRandomString = (length: number) => {
      let result = '';
      const characters =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const charactersLength = characters.length;
      for (let i = 0; i < length; i++) {
        result += characters.charAt(
          Math.floor(Math.random() * charactersLength),
        );
      }
      return result;
    };

    it('should not detect a loop for random content', () => {
      service.reset('');
      for (let i = 0; i < 1000; i++) {
        const content = generateRandomString(10);
        const isLoop = service.addAndCheck(createContentEvent(content));
        expect(isLoop).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should detect a loop when a chunk of content repeats consecutively', () => {
      service.reset('');
      const repeatedContent = 'a'.repeat(CONTENT_CHUNK_SIZE);

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        for (const char of repeatedContent) {
          isLoop = service.addAndCheck(createContentEvent(char));
        }
      }
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop if repetitions are very far apart', () => {
      service.reset('');
      const repeatedContent = 'b'.repeat(CONTENT_CHUNK_SIZE);
      // 填充内容需要足够长，使得平均距离超过 CONTENT_CHUNK_SIZE * 1.5
      // 默认 maxAllowedDistance 是 1.5 * 500 = 750
      // 如果 fillerContent 长度为 500，则两次重复之间的距离是 1000
      const fillerContent = generateRandomString(500);

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        for (const char of repeatedContent) {
          isLoop = service.addAndCheck(createContentEvent(char));
          if (isLoop) break;
        }
        if (isLoop) break;
        for (const char of fillerContent) {
          isLoop = service.addAndCheck(createContentEvent(char));
          if (isLoop) break;
        }
        if (isLoop) break;
      }
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', () => {
      const event = createContentEvent('');
      expect(service.addAndCheck(event)).toBe(false);
    });
  });

  describe('Reset Functionality', () => {
    it('tool call should reset content count', () => {
      const contentEvent = createContentEvent('Some content.');
      const toolEvent = createToolCallRequestEvent('testTool', {
        param: 'value',
      });
      for (let i = 0; i < 9; i++) {
        service.addAndCheck(contentEvent);
      }

      service.addAndCheck(toolEvent);

      // Should start fresh
      expect(service.addAndCheck(createContentEvent('Fresh content.'))).toBe(
        false,
      );
    });
  });

  describe('General Behavior', () => {
    it('should return false for unhandled event types', () => {
      const otherEvent = {
        type: 'unhandled_event',
      } as unknown as ServerGeminiStreamEvent;
      expect(service.addAndCheck(otherEvent)).toBe(false);
      expect(service.addAndCheck(otherEvent)).toBe(false);
    });
  });
});



describe('LoopDetectionService - Preview Model Strict Checking', () => {
  let service: LoopDetectionService;
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createToolCallRequestEvent = (
    name: string,
    args: Record<string, unknown>,
  ): ServerGeminiToolCallRequestEvent => ({
    type: GeminiEventType.ToolCallRequest,
    value: {
      name,
      args,
      callId: 'test-id',
      isClientInitiated: false,
      prompt_id: 'test-prompt-id',
    },
  });

  it('should apply strict tool-name checking for preview models', () => {
    // Setup mock config that returns a preview model
    mockConfig = {
      getTelemetryEnabled: () => true,
      getModel: () => 'gemini-3-pro-preview',
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    service.reset('test-prompt');

    // Call read_file with different args 32 times
    const events = [];
    for (let i = 0; i < 32; i++) {
      events.push(createToolCallRequestEvent('read_file', { file_path: `/path/file${i}.txt` }));
    }

    // First 31 calls should not trigger
    for (let i = 0; i < 31; i++) {
      expect(service.addAndCheck(events[i])).toBe(false);
    }
    expect(loggers.logLoopDetected).not.toHaveBeenCalled();

    // 32th call to read_file should trigger
    expect(service.addAndCheck(events[31])).toBe(true);
    expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
  });

  it('should use threshold of 32 for non-intensive tools in preview models', () => {
    mockConfig = {
      getTelemetryEnabled: () => true,
      getModel: () => 'gemini-3-pro-preview',
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    service.reset('test-prompt');

    // Call shell with different args 32 times
    const events = [];
    for (let i = 0; i < 32; i++) {
      events.push(createToolCallRequestEvent('shell', { command: `ls /dir${i}` }));
    }

    // First 31 calls should not trigger
    for (let i = 0; i < 31; i++) {
      expect(service.addAndCheck(events[i])).toBe(false);
    }
    expect(loggers.logLoopDetected).not.toHaveBeenCalled();

    // 32th call should trigger
    expect(service.addAndCheck(events[31])).toBe(true);
    expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
  });

  it('should not apply preview strict checking for non-preview models', () => {
    mockConfig = {
      getTelemetryEnabled: () => true,
      getModel: () => 'gemini-2.0-flash', // Not a preview model
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    service.reset('test-prompt');

    // Call read_file 10 times with different args
    for (let i = 0; i < 10; i++) {
      const event = createToolCallRequestEvent('read_file', {
        file_path: `/path/file${i}.txt`
      });
      // Should not trigger because args are different (exact match required for non-preview)
      expect(service.addAndCheck(event)).toBe(false);
    }
    expect(loggers.logLoopDetected).not.toHaveBeenCalled();
  });

  it('should detect glob tool calls exceeding threshold in preview models', () => {
    mockConfig = {
      getTelemetryEnabled: () => true,
      getModel: () => 'gemini-3-pro-preview',
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    service.reset('test-prompt');

    // threshold = 32
    const events = [];
    for (let i = 0; i < 32; i++) {
      events.push(createToolCallRequestEvent('glob', { pattern: `**/*.${i}` }));
    }

    // First 31 should pass
    for (let i = 0; i < 31; i++) {
      expect(service.addAndCheck(events[i])).toBe(false);
    }

    // 32th call should trigger
    expect(service.addAndCheck(events[31])).toBe(true);
    expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
  });

  it('should detect search_file_content exceeding threshold in preview models', () => {
    mockConfig = {
      getTelemetryEnabled: () => true,
      getModel: () => 'gemini-3-pro-preview',
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    service.reset('test-prompt');

    // threshold = 32
    const events = [];
    for (let i = 0; i < 32; i++) {
      events.push(createToolCallRequestEvent('search_file_content', { pattern: `pattern${i}` }));
    }

    // First 31 should pass
    for (let i = 0; i < 31; i++) {
      expect(service.addAndCheck(events[i])).toBe(false);
    }

    // 32th call should trigger
    expect(service.addAndCheck(events[31])).toBe(true);
    expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 「畸形工具调用文本」签名检测：detectMalformedToolCallText
//
// 检测模型把 tool_use 降级成纯文本输出的情况（字面量工具调用标记）。
// 与「重复度」内容检测不同，这是「签名匹配」——单次出现即命中。
// 收紧策略：只认"真的想调工具"的形态，并排除围栏代码块内的讨论/文档/教程。
//
// 注意：本测试用拼接（LT='<'）构造 XML 工具调用标签，源码中不出现完整的
// 字面量标签——否则会被各类工具链的工具调用解析器误吞。
// ───────────────────────────────────────────────────────────────────────────
describe('LoopDetectionService - detectMalformedToolCallText (畸形工具调用签名)', () => {
  let service: LoopDetectionService;

  // 用拼接构造标签，源码中不出现完整字面量标签
  const LT = '<';
  const inv = (name: string) => `${LT}invoke name="${name}">`;
  const invClose = `${LT}/invoke>`;
  const fcOpen = `${LT}function_calls>`;
  const fcClose = `${LT}/function_calls>`;
  const param = (n: string, v: string) =>
    `${LT}parameter name="${n}">${v}${LT}/parameter>`;

  beforeEach(() => {
    const mockConfig = {
      getTelemetryEnabled: () => true,
      getModel: () => 'gemini-2.0-flash',
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    vi.clearAllMocks();
  });

  describe('应命中（返回 true）', () => {
    it('完整 function_calls 包裹的 invoke', () => {
      const text =
        fcOpen + inv('read_file') + param('filePath', '/tmp/test') + invClose + fcClose;
      expect(service.detectMalformedToolCallText(text)).toBe(true);
    });

    it('裸 invoke（run_shell_command）', () => {
      const text = inv('run_shell_command') + param('command', 'ls') + invClose;
      expect(service.detectMalformedToolCallText(text)).toBe(true);
    });

    it('带 antml 命名空间的裸 invoke', () => {
      const text =
        `${LT}antml:invoke name="read_file">` +
        param('filePath', '/tmp/test') +
        `${LT}/antml:invoke>`;
      expect(service.detectMalformedToolCallText(text)).toBe(true);
    });

    it('带 antml 命名空间的完整包裹', () => {
      const text =
        `${LT}function_calls>${LT}antml:invoke name="read_file">x${LT}/antml:invoke>${LT}/function_calls>`;
      expect(service.detectMalformedToolCallText(text)).toBe(true);
    });

    it('正文里夹杂一句话 + 一个 invoke 也命中', () => {
      const text = '我来读取文件。\n' + inv('read_file') + param('filePath', '/a') + invClose;
      expect(service.detectMalformedToolCallText(text)).toBe(true);
    });

    it('多个 invoke 混合', () => {
      const text =
        inv('read_file') + param('filePath', '/a') + invClose +
        '\n' +
        inv('run_shell_command') + param('command', 'ls') + invClose;
      expect(service.detectMalformedToolCallText(text)).toBe(true);
    });

    it.each([
      'read_file',
      'run_shell_command',
      'search_file_content',
      'glob',
      'write_file',
      'edit_file',
    ])('各种常见工具名都能命中：%s', (toolName) => {
      const text = inv(toolName) + param('x', 'y') + invClose;
      expect(service.detectMalformedToolCallText(text)).toBe(true);
    });

    it('参数是 JSON 的 invoke', () => {
      const text =
        inv('edit_file') + param('args', '{"path":"/a","old":"x","new":"y"}') + invClose;
      expect(service.detectMalformedToolCallText(text)).toBe(true);
    });
  });

  describe('不应命中（返回 false）', () => {
    it('空字符串', () => {
      expect(service.detectMalformedToolCallText('')).toBe(false);
    });

    it('普通对话文本', () => {
      const text = '好的，我已经完成了你要求的修改，所有测试都通过了。';
      expect(service.detectMalformedToolCallText(text)).toBe(false);
    });

    it('围栏代码块内的 invoke（讨论语法/教程）应被剥离', () => {
      const inner = inv('test') + param('x', 'y') + invClose;
      const text = '下面是一个工具调用的例子：\n```xml\n' + inner + '\n```\n以上就是用法。';
      expect(service.detectMalformedToolCallText(text)).toBe(false);
    });

    it('用户讨论 invoke 语法（无引号 name=...，不在代码块内）', () => {
      // 形如 name=... 没有用双引号包裹有效工具名 → 不算"真的想调工具"
      const text = `你应该用 ${LT}invoke name=...> 来调用工具，记得带上参数。`;
      expect(service.detectMalformedToolCallText(text)).toBe(false);
    });

    it('只有 invoke 没有 name 属性', () => {
      const text = `${LT}invoke>` + param('x', 'y') + invClose;
      expect(service.detectMalformedToolCallText(text)).toBe(false);
    });

    it('正常代码内容（非 XML 工具调用）', () => {
      const text = 'function foo() {\n  return bar.invoke({ name: "x" });\n}';
      expect(service.detectMalformedToolCallText(text)).toBe(false);
    });

    it('只有 function_calls 包裹但没有 invoke', () => {
      const text = fcOpen + '\n' + fcClose;
      expect(service.detectMalformedToolCallText(text)).toBe(false);
    });
  });
});
