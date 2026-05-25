/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 自定义模型提供商类型
 * - openai: OpenAI 兼容格式（OpenAI API、Azure OpenAI、Groq、Together AI 等）
 * - openai-responses: OpenAI Responses API 格式（使用 /responses 端点）
 * - anthropic: Anthropic Claude API 格式
 */
export type CustomModelProvider = 'openai' | 'openai-responses' | 'anthropic';

/**
 * 标准化的"思考"配置，跨 provider 统一抽象
 *
 * - mode: on=强制启用 / off=强制禁用 / auto=遵从 provider 默认
 * - effort: 思考力度 low/medium/high；auto 表示由 provider 自定
 * - budgetTokens: 高级用户直接指定 budget tokens（仅 Anthropic 生效）
 *
 * Provider 映射关系：
 * | Provider          | 字段映射                                              |
 * |-------------------|-------------------------------------------------------|
 * | anthropic         | thinking.budget_tokens（low=4000/medium=16000/high=31999）|
 * | openai-responses  | reasoning.effort（low/medium/high 直传）              |
 * | openai (chat)     | 无控制字段，思考由模型自身决定（如 deepseek-reasoner）|
 */
export interface ThinkingConfig {
  /** 启用模式 */
  mode: 'on' | 'off' | 'auto';
  /** 思考力度，可选 */
  effort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'auto';
  /**
   * 直接指定 budget tokens（覆盖 effort）
   * 仅 Anthropic 3.7 / Gemini 2.5 生效
   */
  budgetTokens?: number;
}

/**
 * 默认 ThinkingConfig
 */
export const DEFAULT_THINKING_CONFIG: ThinkingConfig = {
  mode: 'auto',
  effort: 'auto',
};

/**
 * 把 effort 映射为 Anthropic budget_tokens (对于不支持 effort 的老模型/老接口兼容)
 * 参考：https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 */
export function effortToAnthropicBudget(
  effort: ThinkingConfig['effort'] | undefined,
): number {
  switch (effort) {
    case 'low':
      return 4000;
    case 'medium':
      return 16000;
    case 'high':
    case 'max':
    case 'xhigh':
      return 31999;
    case 'auto':
    default:
      return 31999; // 默认采用官方推荐的最大预算
  }
}

/**
 * 把 effort 映射为 Anthropic Adaptive Thinking 的 effort 值
 * Sonnet 4.6 / Opus 4.6 / Opus 4.7 引入，结合 adaptive 模式
 */
export function effortToAnthropicEffort(
  effort: ThinkingConfig['effort'] | undefined,
): 'low' | 'medium' | 'high' | 'max' | 'xhigh' | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max' || effort === 'xhigh') {
    return effort;
  }
  return undefined;
}

/**
 * 把 effort 映射为 OpenAI Responses / Chat Completions 的 reasoning_effort/reasoning.effort 值
 * @see https://platform.openai.com/docs/api-reference/responses/create#responses-create-reasoning
 */
export function effortToOpenAIEffort(
  effort: ThinkingConfig['effort'] | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort;
  }
  if (effort === 'max') {
    return 'high'; // max 降级到 high
  }
  // 'auto' 或 undefined：交给 OpenAI 默认值
  return undefined;
}

/**
 * 把 effort 映射为 Gemini 3 / 3.5 系列的 thinkingLevel
 * @see https://ai.google.dev/gemini-api/docs/thinking
 */
export function effortToGeminiLevel(
  effort: ThinkingConfig['effort'] | undefined,
): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'max':
    case 'xhigh':
      return 'high';
    case 'auto':
    default:
      return undefined; // 让 Gemini 默认决定 (一般 3.5 Flash 默认 medium, 3.1 Pro 默认 high)
  }
}

/**
 * 把 effort 映射为 Gemini 2.5 系列的 thinkingBudget token 数量
 */
export function effortToGeminiBudget(
  effort: ThinkingConfig['effort'] | undefined,
): number | undefined {
  switch (effort) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
    case 'max':
    case 'xhigh':
      return 16384;
    case 'auto':
    default:
      return undefined;
  }
}

/**
 * 判断给定的 Anthropic 模型是否为现代模型 (Claude 4.6, 4.7 及以上或 Mythos 系列)，
 * 这些模型使用 "adaptive" 思考模式，不再接受传统的 "enabled" + "budget_tokens"（会报 400）。
 */
export function isAdaptiveThinkingClaude(modelId: string): boolean {
  const lower = modelId.toLowerCase();

  // 1. Mythos 系列
  if (lower.includes('mythos')) return true;

  // 2. 正则匹配：Claude 4.6, 4.7 及 5.x 以上版本
  // 支持格式：claude-opus-4-6, claude-sonnet-4-7, claude-3-7-sonnet 等
  const versionMatch = lower.match(/claude(?:-[a-z0-9]+)*-(\d+)\.(\d+)/);
  if (versionMatch) {
    const major = parseInt(versionMatch[1], 10);
    const minor = parseInt(versionMatch[2], 10);
    if (major > 4 || (major === 4 && minor >= 6)) {
      return true;
    }
  }

  // 备选兼容（无点命名）：claude-4-6, claude-4-7, claude-5 等
  if (lower.includes('claude-4-6') || lower.includes('claude-4-7') || lower.includes('claude-4-8') || lower.includes('claude-5-')) {
    return true;
  }

  return false;
}

/**
 * 判断 provider 是否支持 thinking 强度调控
 */
export function providerSupportsThinkingControl(
  provider: CustomModelProvider,
): boolean {
  return provider === 'anthropic' || provider === 'openai-responses' || provider === 'openai';
}

/**
 * 自定义模型配置接口
 * 支持用户配置标准OpenAI兼容格式和Claude API格式的自定义模型
 */
export interface CustomModelConfig {
  /** 显示名称，在UI中展示，同时作为唯一标识符 */
  displayName: string;

  /** 提供商类型 */
  provider: CustomModelProvider;

  /** API基础URL */
  baseUrl: string;

  /** API密钥，支持环境变量替换（如 ${OPENAI_API_KEY}） */
  apiKey: string;

  /** 模型ID（传递给API的实际模型名称） */
  modelId: string;

  /** 最大token数（上下文窗口大小） */
  maxTokens?: number;

  /** 是否启用此模型 */
  enabled?: boolean;

  /** 额外的HTTP headers（可选） */
  headers?: Record<string, string>;

  /** 超时时间（毫秒，可选） */
  timeout?: number;

  /**
   * @deprecated 使用 thinking 字段代替。保留此字段仅用于向后兼容旧配置文件。
   *
   * Enable Anthropic extended thinking (only for anthropic provider)
   * - true: Force enable thinking with budget_tokens = min(maxTokens - 1, 31999)
   * - false: Force disable thinking
   * - undefined (default): Auto-enable for all Anthropic models
   *   (Models that don't support thinking will ignore this parameter)
   *
   * When enabled, thinking content will be displayed in the UI as "Reasoning" before the response.
   * Official recommended budget_tokens: 31999
   * @see https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
   */
  enableThinking?: boolean;

  /**
   * 标准化的思考配置，跨 provider 统一抽象。
   * 当 thinking 字段存在时优先使用；否则回退到 enableThinking 字段（向后兼容）。
   *
   * 通过 /thinking 命令可以在运行时覆盖此配置。
   */
  thinking?: ThinkingConfig;
}

/**
 * 解析模型有效的 ThinkingConfig
 *
 * 优先级（高到低）：
 * 1. runtimeOverride（来自 /thinking 命令的会话级覆盖）
 * 2. modelConfig.thinking（模型级配置）
 * 3. modelConfig.enableThinking（向后兼容字段）
 * 4. provider 默认（auto）
 *
 * @param modelConfig 模型配置
 * @param runtimeOverride 运行时覆盖（来自 /thinking 命令）
 */
export function resolveThinkingConfig(
  modelConfig: CustomModelConfig,
  runtimeOverride?: ThinkingConfig,
): ThinkingConfig {
  if (runtimeOverride) {
    return runtimeOverride;
  }
  if (modelConfig.thinking) {
    return modelConfig.thinking;
  }
  // 向后兼容：旧的 enableThinking 字段
  if (modelConfig.enableThinking === true) {
    return { mode: 'on', effort: 'auto' };
  }
  if (modelConfig.enableThinking === false) {
    return { mode: 'off' };
  }
  return { ...DEFAULT_THINKING_CONFIG };
}

/**
 * 生成自定义模型的唯一键
 * 基于 provider + baseUrl + modelId 确定唯一性
 */
export function generateCustomModelKey(config: CustomModelConfig): string {
  return `${config.provider}|${config.baseUrl}|${config.modelId}`;
}

/**
 * 生成自定义模型的内部ID（用于 UI 选择和配置保存）
 * 格式: custom:{provider}:{modelId}@{baseUrlHash}
 *
 * 使用简短的 baseUrl hash 避免 ID 过长，同时保证唯一性
 */
export function generateCustomModelId(config: CustomModelConfig): string {
  // 简单的字符串哈希函数
  const hashString = (str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36).substring(0, 6);
  };

  const baseUrlHash = hashString(config.baseUrl);
  return `custom:${config.provider}:${config.modelId}@${baseUrlHash}`;
}

/**
 * @deprecated 使用 generateCustomModelId(config) 代替
 * 仅用于向后兼容旧格式 custom:{displayName}
 */
export function generateLegacyCustomModelId(displayName: string): string {
  return `custom:${displayName}`;
}

/**
 * 从内部ID提取provider
 * 支持新格式 custom:{provider}:{modelId}@{hash} 和旧格式 custom:{displayName}
 */
export function extractProvider(modelId: string): CustomModelProvider | null {
  if (!isCustomModel(modelId)) {
    return null;
  }
  const withoutPrefix = modelId.replace('custom:', '');
  if (withoutPrefix.startsWith('openai-responses:')) {
    return 'openai-responses';
  }
  if (withoutPrefix.startsWith('openai:')) {
    return 'openai';
  }
  if (withoutPrefix.startsWith('anthropic:')) {
    return 'anthropic';
  }
  return null;
}

/**
 * 验证自定义模型配置
 */
export function validateCustomModelConfig(config: CustomModelConfig): string[] {
  const errors: string[] = [];

  if (!config.displayName || typeof config.displayName !== 'string') {
    errors.push('displayName is required and must be a string');
  }

  if (!['openai', 'openai-responses', 'anthropic'].includes(config.provider)) {
    errors.push('provider must be one of: openai, openai-responses, anthropic');
  }

  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    errors.push('baseUrl is required and must be a string');
  }

  if (!config.apiKey || typeof config.apiKey !== 'string') {
    errors.push('apiKey is required and must be a string');
  }

  if (!config.modelId || typeof config.modelId !== 'string') {
    errors.push('modelId is required and must be a string');
  }

  if (config.maxTokens !== undefined && (typeof config.maxTokens !== 'number' || config.maxTokens <= 0)) {
    errors.push('maxTokens must be a positive number if specified');
  }

  if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout <= 0)) {
    errors.push('timeout must be a positive number if specified');
  }

  return errors;
}

/**
 * 检查模型是否为自定义模型
 * 格式: custom:{displayName}
 */
export function isCustomModel(modelName: string): boolean {
  return modelName.startsWith('custom:');
}
