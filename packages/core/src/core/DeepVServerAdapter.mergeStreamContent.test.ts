/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 单元测试：DeepVServerAdapter.mergeStreamContent + finalizeAccumulatedToolChunk
 *
 * 这组测试守护一个关键的 bug 修复：
 *
 * 当 SSE 流式响应把一个 functionCall 拆成多个 chunk（先 name、再分批 args、
 * 最后 finishReason），如果客户端把每个 chunk 立即 yield 给 Turn.run()，
 * Turn 会把同一个工具调用 push 成多个残缺的 ToolCallRequest（甚至出现
 * args 缺失或 name 缺失），最终 finishReason=FUNCTION_CALL 但
 * functionCalls=0，工具调用被静默丢弃。
 *
 * 修复方案：在 createStreamGenerator 里累积合并 functionCall chunk，等
 * 流结束才一次性 yield 完整 chunk；mergeStreamContent + finalize 是这套
 * 累积合并的核心。
 */

import { describe, it, expect } from 'vitest';
import { DeepVServerAdapter } from './DeepVServerAdapter.js';

// 把 prototype 上的私有方法借出来做白盒测试
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = (DeepVServerAdapter as any).prototype;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const merge = (acc: any, chunk: any) => proto.mergeStreamContent.call({}, acc, chunk);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const finalize = (chunk: any) => proto.finalizeAccumulatedToolChunk.call({}, chunk);

describe('DeepVServerAdapter.mergeStreamContent', () => {
  it('returns deep-cloned chunk on first call (accumulator init)', () => {
    const original = {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'hello' }] },
        },
      ],
    };
    const acc = merge(null, original);
    // 修改 acc 不应该污染 original
    acc.candidates[0].content.parts[0].text = 'mutated';
    expect(original.candidates[0].content.parts[0].text).toBe('hello');
  });

  it('attaches a functionCalls getter that reflects current parts', () => {
    const acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'c1', name: 'tool_a', args: { x: 1 } } }],
          },
        },
      ],
    });
    expect(acc.functionCalls).toEqual([
      { id: 'c1', name: 'tool_a', args: { x: 1 } },
    ]);
  });

  it('appends text to the last text part to avoid fragmentation', () => {
    let acc = merge(null, {
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hel' }] } }],
    });
    acc = merge(acc, {
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'lo' }] } }],
    });
    acc = merge(acc, {
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' world' }] } }],
    });
    expect(acc.candidates[0].content.parts).toHaveLength(1);
    expect(acc.candidates[0].content.parts[0].text).toBe('Hello world');
  });

  it('accumulates string args across chunks (streamed JSON fragments)', () => {
    let acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'c1', name: 'local_time' } }],
          },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { args: '{"timezo' } }] },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { args: 'ne":"Asia/Shanghai"}' } }],
          },
        },
      ],
    });
    const fc = acc.candidates[0].content.parts[0].functionCall;
    expect(fc.name).toBe('local_time');
    expect(fc.args).toBe('{"timezone":"Asia/Shanghai"}');
  });

  it('shallow-merges object args across chunks', () => {
    let acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'c1', name: 'tool_x', args: { a: 1 } } }],
          },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { args: { b: 2 } } }],
          },
        },
      ],
    });
    expect(acc.candidates[0].content.parts[0].functionCall.args).toEqual({ a: 1, b: 2 });
  });

  it('merges finishReason from later chunk into accumulator', () => {
    let acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'tool_x' } }] },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
    });
    expect(acc.candidates[0].finishReason).toBe('STOP');
  });

  it('fills missing functionCall.id with a generated id', () => {
    const acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'tool_no_id', args: { v: 1 } } }],
          },
        },
      ],
    });
    const fc = acc.candidates[0].content.parts[0].functionCall;
    expect(fc.id).toBeDefined();
    expect(fc.id).toMatch(/^call_/);
  });

  it('handles a chunk that contains both text and functionCall parts', () => {
    const acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { text: "I'll check the time." },
              { functionCall: { id: 'c1', name: 'local_time', args: {} } },
            ],
          },
        },
      ],
    });
    const parts = acc.candidates[0].content.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("I'll check the time.");
    expect(parts[1].functionCall.name).toBe('local_time');
  });
});

describe('DeepVServerAdapter.finalizeAccumulatedToolChunk', () => {
  it('parses string args back into object after stream merge', () => {
    const chunk = {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'c1',
                  name: 'local_time',
                  args: '{"timezone":"Asia/Shanghai"}',
                },
              },
            ],
          },
        },
      ],
    };
    finalize(chunk);
    expect(chunk.candidates[0].content.parts[0].functionCall.args).toEqual({
      timezone: 'Asia/Shanghai',
    });
  });

  it('replaces empty/undefined args with empty object', () => {
    const chunk = {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { functionCall: { id: 'c1', name: 'local_time', args: '' } },
              { functionCall: { id: 'c2', name: 'tool2', args: undefined } },
              { functionCall: { id: 'c3', name: 'tool3', args: null } },
            ],
          },
        },
      ],
    };
    finalize(chunk);
    expect(chunk.candidates[0].content.parts[0].functionCall.args).toEqual({});
    expect(chunk.candidates[0].content.parts[1].functionCall.args).toEqual({});
    expect(chunk.candidates[0].content.parts[2].functionCall.args).toEqual({});
  });

  it('keeps invalid JSON as raw string for downstream error reporting', () => {
    const chunk = {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'c1',
                  name: 'broken_tool',
                  args: '{invalid json',
                },
              },
            ],
          },
        },
      ],
    };
    finalize(chunk);
    // 解析失败时保留原字符串，让 SchemaValidator 能输出更准确的错误
    expect(chunk.candidates[0].content.parts[0].functionCall.args).toBe('{invalid json');
  });

  it('is a no-op for chunks without parts', () => {
    const chunk = { candidates: [{ index: 0 }] };
    expect(() => finalize(chunk)).not.toThrow();
  });
});

describe('mergeStreamContent + finalize end-to-end (streamed local_time call)', () => {
  it('reconstructs a complete functionCall from 5 fragmented chunks', () => {
    let acc: ReturnType<typeof merge> | null = null;

    // chunk 1: 模型先输出文本
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: "Sure, I'll check the time." }] },
        },
      ],
    });

    // chunk 2: functionCall name 出现
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'call_1', name: 'local_time' } }],
          },
        },
      ],
    });

    // chunk 3 & 4: args 字符串增量
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { args: '{"timezo' } }] },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { args: 'ne":"Asia/Shanghai"}' } }],
          },
        },
      ],
    });

    // chunk 5: finishReason
    acc = merge(acc, {
      candidates: [
        { index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' },
      ],
    });

    finalize(acc);

    const parts = acc!.candidates[0].content.parts;
    const textPart = parts.find((p: { text?: string }) => p.text);
    const fcPart = parts.find(
      (p: { functionCall?: { name: string; args: unknown } }) => p.functionCall,
    );

    expect(textPart?.text).toBe("Sure, I'll check the time.");
    expect(fcPart?.functionCall?.name).toBe('local_time');
    expect(fcPart?.functionCall?.args).toEqual({ timezone: 'Asia/Shanghai' });
    expect(acc!.candidates[0].finishReason).toBe('STOP');

    // 关键回归断言：经过完整合并后 functionCalls 必须能被 turn.ts 看见
    expect(acc!.functionCalls).toBeDefined();
    expect(acc!.functionCalls).toHaveLength(1);
    expect(acc!.functionCalls[0]).toEqual({
      id: 'call_1',
      name: 'local_time',
      args: { timezone: 'Asia/Shanghai' },
    });
  });
});

describe('DeepVServerAdapter.cleanContents', () => {
  const cleanContents = (contents: any[]) => proto.cleanContents.call({}, contents);

  it('filters out empty or whitespace-only text parts within a message', () => {
    const input = [
      {
        role: 'user',
        parts: [
          { text: '  ' }, // whitespace-only text part
          { text: 'Hello' },
          { text: '' }, // empty text part
          { inlineData: { mimeType: 'image/png', data: 'abc' } }, // valid image part
        ],
      },
    ];

    const result = cleanContents(input);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts[0].text).toBe('Hello');
    expect(result[0].parts[1].inlineData).toEqual({ mimeType: 'image/png', data: 'abc' });
  });

  it('completely removes a message if all parts are filtered out as invalid', () => {
    const input = [
      {
        role: 'user',
        parts: [
          { text: '   ' },
          { text: '' },
        ],
      },
      {
        role: 'user',
        parts: [
          { text: 'Keep this' },
        ],
      },
    ];

    const result = cleanContents(input);

    expect(result).toHaveLength(1);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].text).toBe('Keep this');
  });
});
