/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for SubAgent current-model context injection.
 *
 * When the user explicitly configures a per-sub-agent model override (via
 * /config → modelOverrides.codeExpert / .verification), SubAgent.buildSystemPrompt
 * appends an i18n notice telling the sub-agent which model it actually runs on,
 * using the override's real model name. This lets the sub-agent answer "which
 * model are you" truthfully and makes the override verifiable on a real machine.
 *
 * When NO override is set the sub-agent simply inherits the session model — and
 * nothing is injected (we don't add a model block in that case).
 */

import { describe, it, expect } from 'vitest';
import { SubAgent } from './subAgent.js';
import { t } from '../utils/simpleI18n.js';
import type { AgentDefinition } from '../agents/agentDefinition.js';

const BASE_PROMPT = 'You are a code analysis expert.';

// A minimal agentDefinition keeps buildSystemPrompt on the simple branch
// (returns agentDefinition.systemPrompt) so we exercise only the model-context append.
const AGENT_DEFINITION = {
  name: 'code-analysis',
  displayName: 'Code Analysis Expert',
  systemPrompt: BASE_PROMPT,
  tools: [],
} as unknown as AgentDefinition;

/**
 * Build a SubAgent with the minimal mocked dependencies its constructor touches.
 * @param model        value returned by config.getModel()
 * @param modelOverride optional per-agent model override
 * @param customModels  map of custom-model-id -> custom config for getCustomModelConfig
 */
function makeSubAgent(
  model: string,
  modelOverride?: string,
  customModels: Record<string, unknown> = {},
): SubAgent {
  const config = {
    getProjectRoot: () => process.cwd(),
    getSessionId: () => 'test-session',
    getHookSystem: () => ({ getEventHandler: () => undefined }),
    getApprovalMode: () => undefined,
    getModel: () => model,
    getCustomModelConfig: (id: string) => customModels[id],
  } as any;

  const toolRegistry = {
    getAllTools: () => [],
  } as any;

  const geminiClient = {} as any;

  return new SubAgent(
    config,
    toolRegistry,
    geminiClient,
    undefined, // updateOutput
    undefined, // abortSignal
    undefined, // externalPreToolExecutionHandler
    AGENT_DEFINITION,
    modelOverride,
  );
}

describe('SubAgent current-model context injection', () => {
  it('injects the i18n override notice with the overridden model name', () => {
    const subAgent = makeSubAgent('gemini-2.5-pro', 'deepseek-v4-flash');
    const prompt = (subAgent as any).buildSystemPrompt() as string;

    expect(prompt).toContain(BASE_PROMPT);
    expect(prompt).toContain(
      t('subagent.model.override.notice', { model: 'deepseek-v4-flash' }),
    );
    // The override name must be present; the session model must not leak in.
    expect(prompt).toContain('deepseek-v4-flash');
    expect(prompt).not.toContain('gemini-2.5-pro');
  });

  it('injects NOTHING when no override is set (silently inherits session model)', () => {
    const subAgent = makeSubAgent('gemini-2.5-pro');
    const prompt = (subAgent as any).buildSystemPrompt() as string;

    // No override → no appended block at all, just the base system prompt.
    expect(prompt).toBe(BASE_PROMPT);
    expect(prompt).not.toContain('gemini-2.5-pro');
  });

  it('uses the real modelId for a custom-model override', () => {
    const customId = 'custom:openai:deepseek-v4@abc123';
    const subAgent = makeSubAgent('gemini-2.5-pro', customId, {
      [customId]: {
        provider: 'openai',
        modelId: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.example/v1',
        displayName: 'My DeepSeek',
      },
    });
    const prompt = (subAgent as any).buildSystemPrompt() as string;

    expect(prompt).toContain(
      t('subagent.model.override.notice', { model: 'deepseek-v4-flash' }),
    );
    // The opaque custom: id should not be shown — the resolved modelId is.
    expect(prompt).not.toContain(customId);
  });

  it('falls back to the raw override id when a custom model has no resolvable config', () => {
    const customId = 'custom:openai:ghost@000000';
    const subAgent = makeSubAgent('gemini-2.5-pro', customId, {});
    const prompt = (subAgent as any).buildSystemPrompt() as string;

    expect(prompt).toContain(
      t('subagent.model.override.notice', { model: customId }),
    );
  });
});
