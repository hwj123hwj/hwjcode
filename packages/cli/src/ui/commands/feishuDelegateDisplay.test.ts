/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildDelegateDisplayBox,
  applyDelegateFooterMetrics,
} from './feishuCommand.js';

describe('buildDelegateDisplayBox', () => {
  it('renders a placeholder header when there is no structured data', () => {
    const out = buildDelegateDisplayBox(undefined, { agent: 'codex' }, true);
    expect(out).toContain('外部 Agent 执行报告');
    // Falls back to the agent label inferred from args.
    expect(out).toContain('Codex');
    expect(out).toContain('启动中');
    // No transcript code block when there is no data.
    expect(out).not.toContain('最近输出');
  });

  it('renders structured progress fields (model, tool, plan, token)', () => {
    const data = {
      agent: 'claude-code',
      label: 'Claude Code',
      transcript: '',
      progress: {
        model: 'DeepSeek-V4-Pro',
        currentTool: 'Bash: npm test',
        toolCallCount: 5,
        plan: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'pending' },
        ],
        tokenUsed: 1234,
        tokenSize: 10000,
        lastActivityAt: 0,
      },
    };
    const out = buildDelegateDisplayBox(data, {}, true);
    expect(out).toContain('Claude Code');
    expect(out).toContain('DeepSeek-V4-Pro');
    expect(out).toContain('执行中');
    expect(out).toContain('当前工具');
    expect(out).toContain('Bash: npm test');
    expect(out).toContain('工具调用: 5 次');
    expect(out).toContain('计划进度: 1 / 3');
    expect(out).toContain('Token: 1234 / 10000 (12%)');
  });

  it('shows "已完成" when not live', () => {
    const out = buildDelegateDisplayBox(
      { label: 'Codex', transcript: '', progress: { toolCallCount: 0, lastActivityAt: 0 } },
      {},
      false,
    );
    expect(out).toContain('已完成');
    expect(out).not.toContain('执行中');
  });

  it('renders the transcript tail in a fenced code block', () => {
    const data = {
      label: 'Claude Code',
      transcript: 'line A\nline B\n```console\nhello from bash\n```',
      progress: { toolCallCount: 1, lastActivityAt: 0 },
    };
    const out = buildDelegateDisplayBox(data, {}, true);
    expect(out).toContain('最近输出');
    expect(out).toContain('hello from bash');
  });

  it('omits the output block for an empty transcript', () => {
    const out = buildDelegateDisplayBox(
      { label: 'Codex', transcript: '   ', progress: { toolCallCount: 0, lastActivityAt: 0 } },
      {},
      true,
    );
    expect(out).not.toContain('最近输出');
  });

  it('clamps an overlong transcript to the tail', () => {
    const many = Array.from({ length: 200 }, (_, i) => `out line ${i}`).join('\n');
    const out = buildDelegateDisplayBox(
      { label: 'Codex', transcript: many, progress: { toolCallCount: 1, lastActivityAt: 0 } },
      {},
      true,
    );
    // The tail (latest) lines are kept; early lines dropped.
    expect(out).toContain('out line 199');
    expect(out).not.toContain('out line 0\n');
    // Only the last 30 lines survive in the output block.
    expect(out).toContain('out line 170');
    expect(out).not.toContain('out line 169');
  });

  it('widens the fence when the transcript contains long backtick runs', () => {
    const data = {
      label: 'Codex',
      transcript: 'before\n````\ncode with fence\n````\nafter',
      progress: { toolCallCount: 1, lastActivityAt: 0 },
    };
    const out = buildDelegateDisplayBox(data, {}, true);
    // Outer fence must be longer than the inner ```` (4) → at least 5 backticks.
    expect(out).toContain('`````');
  });

  it('handles missing progress gracefully', () => {
    const out = buildDelegateDisplayBox(
      { label: 'Claude Code', transcript: 'hi' },
      {},
      true,
    );
    expect(out).toContain('Claude Code');
    expect(out).toContain('最近输出');
    // No tool/plan/token lines when progress is absent.
    expect(out).not.toContain('当前工具');
    expect(out).not.toContain('计划进度');
  });

  it('renders the latest agent narration as a stable 💬 line', () => {
    const out = buildDelegateDisplayBox(
      {
        label: 'Claude Code',
        transcript: '',
        progress: {
          lastMessage: 'Let me check the auth module first.',
          toolCallCount: 0,
          lastActivityAt: 0,
        },
      },
      {},
      true,
    );
    expect(out).toContain('💬 最新');
    expect(out).toContain('Let me check the auth module first.');
  });

  it('folds and clamps an overlong narration to a single line', () => {
    const long = 'A'.repeat(300);
    const out = buildDelegateDisplayBox(
      {
        label: 'Codex',
        transcript: '',
        progress: { lastMessage: `multi\nline\n${long}`, toolCallCount: 0, lastActivityAt: 0 },
      },
      {},
      true,
    );
    const line = out.split('\n').find((l) => l.includes('💬 最新'));
    expect(line).toBeDefined();
    // Newlines were folded away and the text was clamped with an ellipsis.
    expect(line).toContain('…');
    expect(line!.length).toBeLessThan(140);
  });

  it('uses a semantic tool emoji from currentToolKind instead of a hourglass', () => {
    const out = buildDelegateDisplayBox(
      {
        label: 'Claude Code',
        transcript: '',
        progress: {
          currentTool: 'npm test',
          currentToolKind: 'execute',
          toolCallCount: 1,
          lastActivityAt: 0,
        },
      },
      {},
      true,
    );
    expect(out).toContain('当前工具: ⚡ npm test');
    expect(out).not.toContain('⏳ npm test');
  });

  it('suppresses the current-tool line when not live (no stale running tool)', () => {
    const out = buildDelegateDisplayBox(
      {
        label: 'Codex',
        transcript: '',
        progress: {
          currentTool: 'Edit foo.ts',
          currentToolKind: 'edit',
          toolCallCount: 1,
          lastActivityAt: 0,
        },
      },
      {},
      false,
    );
    expect(out).not.toContain('当前工具');
  });
});

describe('applyDelegateFooterMetrics', () => {
  it('overrides model with progress.model and tokens with progress token usage', () => {
    const metrics = { model: 'easycode-own-model', tokens: { input: 1, output: 2 } };
    const out = applyDelegateFooterMetrics(metrics, {
      label: 'Claude Code',
      progress: { model: 'DeepSeek-V4-Pro', tokenUsed: 500, tokenSize: 2000, lastActivityAt: 0 },
    });
    expect(out.model).toBe('DeepSeek-V4-Pro');
    expect(out.tokens).toEqual({ input: 500, output: 0 });
    expect(out.contextPercentage).toBe(25);
  });

  it('falls back to the agent label when progress.model is absent', () => {
    const metrics = { model: 'easycode-own-model' };
    const out = applyDelegateFooterMetrics(metrics, {
      label: 'Codex',
      progress: { tokenUsed: 100, lastActivityAt: 0 },
    });
    expect(out.model).toBe('Codex');
    expect(out.tokens).toEqual({ input: 100, output: 0 });
    // No tokenSize → no context percentage.
    expect(out.contextPercentage).toBeUndefined();
  });

  it('leaves metrics untouched when there is no delegate data', () => {
    const metrics = { model: 'easycode-own-model', tokens: { input: 9, output: 9 } };
    const out = applyDelegateFooterMetrics(metrics, undefined);
    expect(out.model).toBe('easycode-own-model');
    expect(out.tokens).toEqual({ input: 9, output: 9 });
  });

  it('keeps the existing model when neither progress.model nor label is present', () => {
    const metrics = { model: 'easycode-own-model' };
    const out = applyDelegateFooterMetrics(metrics, { progress: {} });
    expect(out.model).toBe('easycode-own-model');
  });
});
