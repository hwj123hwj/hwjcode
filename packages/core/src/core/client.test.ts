/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「畸形工具调用检测 + 自愈链」的单元测试。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 被测对象
 * ─────────────────────────────────────────────────────────────────────────
 * GeminiClient.healMalformedToolCall —— 当 sendMessageStream 检测到模型把
 * tool_use 降级成纯文本时，由它编排的自愈阶梯：
 *
 *   step 1 → 轻量重试（注入修正提示，仅以结构化 tool_use 重新发起）
 *   step 2 → tryCompressChat（清空被污染的上下文，与 80% 阈值压缩一致）
 *   step 3 → microCompress（runMicroCompactFallback 轻量瘦身）
 *   step ≥4 → 降级提示用户
 *
 * 隔离手法：用 Object.create(GeminiClient.prototype) 跳过 constructor 的依赖
 * （与 client.compressionFallback.test.ts / client.setHistory.sanitize.test.ts
 * 同款手法），再把 heal 依赖的实例方法（sendMessageStream / tryCompressChat /
 * runMicroCompactFallback）替换成 vi.fn，从而隔离 loopDetectionService /
 * compressionService / microCompactService 这些外部依赖。
 */

import { describe, it, expect, vi } from 'vitest';
import { GeminiClient } from './client.js';
import { GeminiEventType, Turn } from './turn.js';

// ───────────────────────────────────────────────────────────────────────────
// 工具：完整驱动一个 async generator，收集 yield 出的事件和最终 return 值
// ───────────────────────────────────────────────────────────────────────────
async function drive<T, R>(
  gen: AsyncGenerator<T, R>,
): Promise<{ events: T[]; ret: R }> {
  const events: T[] = [];
  let res = await gen.next();
  while (!res.done) {
    events.push(res.value as T);
    res = await gen.next();
  }
  return { events, ret: res.value as R };
}

// ───────────────────────────────────────────────────────────────────────────
// 工具：构造一个"裸"client，stub 掉 heal 依赖的全部实例方法
// ───────────────────────────────────────────────────────────────────────────
function makeHealClient(step: number) {
  const client = Object.create(GeminiClient.prototype) as any;
  client.malformedRecoveryStep = step;
  client.config = { getModel: () => 'test-model' };

  const fakeChat = { getHistory: () => [], setHistory: vi.fn() };
  client.getChat = vi.fn().mockReturnValue(fakeChat);

  // 重试用的哨兵 Turn —— 用它来断言 heal 把重试结果原样 return 出去
  const sentinelTurn = new Turn(fakeChat as any, 'pid', 'test-model');
  (sentinelTurn as any).__sentinel = 'retry-result';
  client.__sentinelTurn = sentinelTurn;

  // sendMessageStream：模拟成功重试 —— yield 一个内层事件，return 哨兵 Turn
  client.sendMessageStream = vi.fn(async function* () {
    yield { type: GeminiEventType.Content, value: '[retry-stream]' };
    return sentinelTurn;
  });

  // tryCompressChat：默认压缩成功
  client.tryCompressChat = vi
    .fn()
    .mockResolvedValue({ originalTokenCount: 100, newTokenCount: 40 });

  // runMicroCompactFallback：默认清理了若干条
  client.runMicroCompactFallback = vi
    .fn()
    .mockReturnValue({ applied: true, clearedCount: 3 });

  return client;
}

const newSignal = () => new AbortController().signal;

describe('GeminiClient.healMalformedToolCall —— 自愈阶梯', () => {
  describe('Step 1：轻量重试', () => {
    it('仅注入修正提示并重试，不触发压缩 / 微压缩', async () => {
      const c = makeHealClient(1);
      const { events, ret } = await drive(
        c.healMalformedToolCall(newSignal(), 'pid', 5, 'init-model'),
      );

      // 只走了重试这一条路
      expect(c.sendMessageStream).toHaveBeenCalledTimes(1);
      expect(c.tryCompressChat).not.toHaveBeenCalled();
      expect(c.runMicroCompactFallback).not.toHaveBeenCalled();

      // 重试请求里带有修正提示
      const retryRequest = c.sendMessageStream.mock.calls[0][0];
      const asText = JSON.stringify(retryRequest);
      expect(asText).toContain('system-reminder');
      expect(asText).toContain('结构化');

      // 透传了内层流事件，且把重试 Turn 原样 return
      expect(events.some((e) => e.type === GeminiEventType.Content)).toBe(true);
      expect(ret).toBe(c.__sentinelTurn);
    });

    it('boundedTurns 递减后传给重试（5 → 4）', async () => {
      const c = makeHealClient(1);
      await drive(c.healMalformedToolCall(newSignal(), 'pid', 5, 'init-model'));
      // sendMessageStream(request, signal, prompt_id, turns, originalModel)
      expect(c.sendMessageStream.mock.calls[0][3]).toBe(4);
      expect(c.sendMessageStream.mock.calls[0][4]).toBe('init-model');
    });
  });

  describe('Step 2：全量压缩 tryCompressChat', () => {
    it('触发 tryCompressChat(force=true)，yield ChatCompressed 气泡，再重试', async () => {
      const c = makeHealClient(2);
      const { events } = await drive(
        c.healMalformedToolCall(newSignal(), 'pid', 5, 'init-model'),
      );

      expect(c.tryCompressChat).toHaveBeenCalledTimes(1);
      // 第三个参数 force=true —— 与 80% 阈值压缩走完全相同的强制路径
      expect(c.tryCompressChat.mock.calls[0][2]).toBe(true);

      // yield 了流式压缩气泡事件（结构与 sendMessageStream 主路径一致）
      const compressed = events.find(
        (e) => e.type === GeminiEventType.ChatCompressed,
      ) as any;
      expect(compressed).toBeDefined();
      expect(compressed.value.success).toBe(true);
      expect(compressed.value.info).toBeDefined();

      // 压缩后仍然重试一次
      expect(c.sendMessageStream).toHaveBeenCalledTimes(1);
      // 没有越级到 microCompress
      expect(c.runMicroCompactFallback).not.toHaveBeenCalled();
    });

    it('压缩抛错也不致命：吞掉异常后仍重试，且不 yield 气泡', async () => {
      const c = makeHealClient(2);
      c.tryCompressChat = vi.fn().mockRejectedValue(new Error('boom'));

      const { events } = await drive(
        c.healMalformedToolCall(newSignal(), 'pid', 5, 'init-model'),
      );

      expect(c.tryCompressChat).toHaveBeenCalledTimes(1);
      expect(
        events.find((e) => e.type === GeminiEventType.ChatCompressed),
      ).toBeUndefined();
      // 关键：压缩失败不阻断自愈，仍然重试
      expect(c.sendMessageStream).toHaveBeenCalledTimes(1);
    });

    it('压缩返回 null 时不 yield 气泡，但仍重试', async () => {
      const c = makeHealClient(2);
      c.tryCompressChat = vi.fn().mockResolvedValue(null);

      const { events } = await drive(
        c.healMalformedToolCall(newSignal(), 'pid', 5, 'init-model'),
      );

      expect(
        events.find((e) => e.type === GeminiEventType.ChatCompressed),
      ).toBeUndefined();
      expect(c.sendMessageStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('Step 3：微压缩 microCompress', () => {
    it('触发 runMicroCompactFallback 后重试，不再触发全量压缩', async () => {
      const c = makeHealClient(3);
      await drive(c.healMalformedToolCall(newSignal(), 'pid', 5, 'init-model'));

      expect(c.runMicroCompactFallback).toHaveBeenCalledTimes(1);
      expect(c.tryCompressChat).not.toHaveBeenCalled();
      expect(c.sendMessageStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('Step ≥4：降级提示用户', () => {
    it('Step 4：不再重试 / 压缩 / 微压缩，yield 降级提示并返回 Turn', async () => {
      const c = makeHealClient(4);
      const { events, ret } = await drive(
        c.healMalformedToolCall(newSignal(), 'pid', 5, 'init-model'),
      );

      expect(c.sendMessageStream).not.toHaveBeenCalled();
      expect(c.tryCompressChat).not.toHaveBeenCalled();
      expect(c.runMicroCompactFallback).not.toHaveBeenCalled();

      const notice = events.find(
        (e) => e.type === GeminiEventType.Content,
      ) as any;
      expect(notice).toBeDefined();
      expect(notice.value).toContain('⚠️');

      // 降级分支构造并返回一个 Turn，外层不再做 nextSpeaker 续跑
      expect(ret).toBeInstanceOf(Turn);
    });

    it('Step 7（更高阶梯）同样走降级分支', async () => {
      const c = makeHealClient(7);
      const { events } = await drive(
        c.healMalformedToolCall(newSignal(), 'pid', 5, 'init-model'),
      );
      expect(c.sendMessageStream).not.toHaveBeenCalled();
      expect(
        events.some(
          (e) =>
            e.type === GeminiEventType.Content &&
            String((e as any).value).includes('⚠️'),
        ),
      ).toBe(true);
    });
  });

  describe('边界：boundedTurns 耗尽', () => {
    it('boundedTurns=0 时 nextTurns 不为负（兜底为 0）', async () => {
      const c = makeHealClient(1);
      await drive(c.healMalformedToolCall(newSignal(), 'pid', 0, 'init-model'));
      // nextTurns = max(0, 0 - 1) = 0
      expect(c.sendMessageStream.mock.calls[0][3]).toBe(0);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 并发保护：tryCompressChat 的 isCompressing 重入锁
// （Step 2 依赖它重入安全；这里直接对真实方法验证锁）
// ───────────────────────────────────────────────────────────────────────────
describe('GeminiClient.tryCompressChat —— isCompressing 重入锁', () => {
  it('isCompressing=true 时立即返回 null，不进入压缩流程', async () => {
    const c = Object.create(GeminiClient.prototype) as any;
    c.isCompressing = true;
    // 锁检查在方法最前面，return null 前不触碰任何外部依赖；
    // 若误入流程会因缺少 config/hookSystem 等依赖而抛错。返回 null 即证明锁生效。
    const result = await c.tryCompressChat('pid', newSignal(), false);
    expect(result).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 检测三重门控（sendMessageStream 内联逻辑）
//
// 门控：pendingToolCallCount === 0 && lastFinishReason === 'STOP'
//        && !signal.aborted && loopDetector.detectMalformedToolCallText(text)
//
// 其中「文本签名」这一项已在 loopDetectionService.test.ts 充分覆盖。
// 余下三个结构性条件内联在 sendMessageStream 的流尾，要真正驱动它需要搭建
// 完整的 turn.run 流 + chat + contentGenerator + loopDetector + 各类 hook 的
// 集成夹具，成本高、脆弱，按要求以 skip 占位并注明原因（属端到端/集成范畴）。
// ───────────────────────────────────────────────────────────────────────────
describe('检测三重门控（集成，需完整 sendMessageStream 夹具）', () => {
  it.skip('pendingToolCalls > 0 时不触发自愈 —— 需驱动完整 sendMessageStream 流', () => {
    // 原因：门控内联在 sendMessageStream 流尾，需 mock turn.run 产出带 STOP/无
    // 工具调用的流，并贯通 chat/contentGenerator/hook，属集成测试范畴。
  });

  it.skip('finishReason 不是 STOP 时不触发自愈 —— 同上，需集成夹具', () => {
    // 原因：lastFinishReason 来自 turn.run yield 的 Finished 事件，须端到端驱动。
  });

  it.skip('三条件全满足时 malformedRecoveryStep 自增并上报 logLoopDetected —— 需集成夹具', () => {
    // 原因：自增与遥测同样内联在 sendMessageStream 检测分支，依赖完整流驱动。
    // 阶梯升级（step++ 后重入 heal）的效果已由上面各 step 的 heal 单测分别覆盖。
  });
});
