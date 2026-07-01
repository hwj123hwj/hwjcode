/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  detectOpenAICompatibleVendor,
  applyOpenAIChatThinking,
  isAdaptiveThinkingClaude,
  type ThinkingConfig,
} from './customModel.js';

describe('detectOpenAICompatibleVendor', () => {
  it('routes OpenAI gpt / o-series ids to "openai"', () => {
    expect(detectOpenAICompatibleVendor('gpt-5.4')).toBe('openai');
    expect(detectOpenAICompatibleVendor('GPT-5.5-codex')).toBe('openai');
    expect(detectOpenAICompatibleVendor('gpt-4o-mini')).toBe('openai');
    expect(detectOpenAICompatibleVendor('o1-preview')).toBe('openai');
    expect(detectOpenAICompatibleVendor('o3')).toBe('openai');
    expect(detectOpenAICompatibleVendor('o3-mini')).toBe('openai');
  });

  it('routes 智谱 ids to "glm"', () => {
    expect(detectOpenAICompatibleVendor('glm-5')).toBe('glm');
    expect(detectOpenAICompatibleVendor('GLM-5-turbo')).toBe('glm');
    expect(detectOpenAICompatibleVendor('glm-5.1')).toBe('glm');
  });

  it('routes Qwen ids to "qwen"', () => {
    expect(detectOpenAICompatibleVendor('qwen3.7-max')).toBe('qwen');
    expect(detectOpenAICompatibleVendor('QWEN3.6-plus')).toBe('qwen');
  });

  it('returns "unknown" for vendors that reject reasoning_effort', () => {
    // These all 400 if we send reasoning_effort; must emit no thinking field.
    expect(detectOpenAICompatibleVendor('deepseek-v4-pro')).toBe('unknown');
    expect(detectOpenAICompatibleVendor('deepseek-v4-flash')).toBe('unknown');
    expect(detectOpenAICompatibleVendor('kimi-k2.6')).toBe('unknown');
    expect(detectOpenAICompatibleVendor('kimi-k2.5')).toBe('unknown');
    expect(detectOpenAICompatibleVendor('grok-4.3')).toBe('unknown');
    expect(detectOpenAICompatibleVendor('MiniMax-M2.7')).toBe('unknown');
    expect(detectOpenAICompatibleVendor('mimo-v2-pro')).toBe('unknown');
  });

  it('does not mistake "kimi" / "mimo" for the o-series regex', () => {
    expect(detectOpenAICompatibleVendor('kimi-k2.6')).toBe('unknown');
    expect(detectOpenAICompatibleVendor('mimo-v2-pro')).toBe('unknown');
  });

  it('handles empty / null-ish input', () => {
    expect(detectOpenAICompatibleVendor('')).toBe('unknown');
    // @ts-expect-error -- runtime guard test
    expect(detectOpenAICompatibleVendor(undefined)).toBe('unknown');
  });
});

describe('applyOpenAIChatThinking', () => {
  const auto: ThinkingConfig = { mode: 'auto', effort: 'auto' };
  const off: ThinkingConfig = { mode: 'off' };
  const on: ThinkingConfig = { mode: 'on', effort: 'high' };

  it('OpenAI gpt-5.4 + auto/auto → no field set (let upstream default decide)', () => {
    const body: Record<string, unknown> = {};
    applyOpenAIChatThinking(body, 'gpt-5.4', auto);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.extra_body).toBeUndefined();
  });

  it('OpenAI gpt-5.5 + on/high → reasoning_effort="high"', () => {
    const body: Record<string, unknown> = {};
    applyOpenAIChatThinking(body, 'gpt-5.5', on);
    expect(body.reasoning_effort).toBe('high');
  });

  it('OpenAI o3-mini + off → reasoning_effort="none"', () => {
    const body: Record<string, unknown> = {};
    applyOpenAIChatThinking(body, 'o3-mini', off);
    expect(body.reasoning_effort).toBe('none');
  });

  it('GLM glm-5 + auto → extra_body.thinking enabled', () => {
    const body: Record<string, unknown> = {};
    applyOpenAIChatThinking(body, 'glm-5', auto);
    expect(body.extra_body).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    });
    // No top-level reasoning_effort for GLM.
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('GLM glm-5.1 + off → extra_body.thinking disabled', () => {
    const body: Record<string, unknown> = {};
    applyOpenAIChatThinking(body, 'glm-5.1', off);
    expect(body.extra_body).toEqual({ thinking: { type: 'disabled' } });
  });

  it('Qwen + on → extra_body.enable_thinking=true', () => {
    const body: Record<string, unknown> = {};
    applyOpenAIChatThinking(body, 'qwen3.7-max', on);
    expect(body.extra_body).toEqual({ enable_thinking: true });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('Qwen + off → extra_body.enable_thinking=false', () => {
    const body: Record<string, unknown> = {};
    applyOpenAIChatThinking(body, 'qwen3.6-plus', off);
    expect(body.extra_body).toEqual({ enable_thinking: false });
  });

  it('preserves existing extra_body keys when patching GLM/Qwen fields', () => {
    const body: Record<string, unknown> = {
      extra_body: { custom_passthrough: 1 },
    };
    applyOpenAIChatThinking(body, 'glm-5', auto);
    expect(body.extra_body).toMatchObject({
      custom_passthrough: 1,
      thinking: { type: 'enabled', clear_thinking: false },
    });
  });

  it('Unknown vendors emit nothing — DeepSeek / Kimi / Grok / MiniMax / MiMo', () => {
    for (const id of [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k2.6',
      'kimi-k2.5',
      'grok-4.3',
      'MiniMax-M2.7',
      'MiniMax-M2.5',
      'mimo-v2-pro',
    ]) {
      const body: Record<string, unknown> = {};
      applyOpenAIChatThinking(body, id, on);
      expect(body, `body for ${id}`).toEqual({});
    }
  });

  it('Unknown vendors with mode=off also emit nothing', () => {
    const body: Record<string, unknown> = {};
    applyOpenAIChatThinking(body, 'deepseek-v4-pro', off);
    expect(body).toEqual({});
  });
});

describe('isAdaptiveThinkingClaude', () => {
  it('returns true for Mythos series', () => {
    expect(isAdaptiveThinkingClaude('claude-mythos')).toBe(true);
    expect(isAdaptiveThinkingClaude('claude-mythos-1.0')).toBe(true);
  });

  it('returns true for Claude 4.6+ (major.minor)', () => {
    expect(isAdaptiveThinkingClaude('claude-sonnet-4-6')).toBe(true);
    expect(isAdaptiveThinkingClaude('claude-opus-4.7')).toBe(true);
    expect(isAdaptiveThinkingClaude('claude-sonnet-4-7-20250219')).toBe(true);
  });

  it('returns true for Claude 5+ with major.minor', () => {
    expect(isAdaptiveThinkingClaude('claude-sonnet-5.1')).toBe(true);
    expect(isAdaptiveThinkingClaude('claude-opus-5.0')).toBe(true);
  });

  it('returns true for Claude models with only major version (Sonnet 5)', () => {
    expect(isAdaptiveThinkingClaude('claude-sonnet-5')).toBe(true);
    expect(isAdaptiveThinkingClaude('claude-5')).toBe(true);
    expect(isAdaptiveThinkingClaude('claude-opus-5')).toBe(true);
  });

  it('returns true for Claude Sonnet 5 with date suffix', () => {
    expect(isAdaptiveThinkingClaude('claude-sonnet-5-20251022')).toBe(true);
  });

  it('returns false for Claude 3.5 / 3.7 / 4.0', () => {
    expect(isAdaptiveThinkingClaude('claude-sonnet-3.5')).toBe(false);
    expect(isAdaptiveThinkingClaude('claude-sonnet-3-7')).toBe(false);
    expect(isAdaptiveThinkingClaude('claude-opus-4.0')).toBe(false);
  });

  it('returns false for unrecognized / non-Claude models', () => {
    expect(isAdaptiveThinkingClaude('gpt-5')).toBe(false);
    expect(isAdaptiveThinkingClaude('deepseek-v4')).toBe(false);
    expect(isAdaptiveThinkingClaude('')).toBe(false);
  });
});
