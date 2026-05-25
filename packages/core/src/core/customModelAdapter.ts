/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  FinishReason,
} from '@google/genai';
import { CustomModelConfig, resolveThinkingConfig, effortToAnthropicBudget, effortToOpenAIEffort, effortToAnthropicEffort } from '../types/customModel.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { retryWithBackoff, getErrorStatus } from '../utils/retry.js';

/**
 * 为对象添加 functionCalls getter，兼容不同的结构
 * - GenerateContentResponse 结构: response.candidates[0].content.parts
 * - Content 结构: content.parts
 */
function addFunctionCallsGetter(obj: any) {
  if (!obj) return;

  // 检查是否已经有该属性或 getter
  const descriptor = Object.getOwnPropertyDescriptor(obj, 'functionCalls');
  if (descriptor) return;

  Object.defineProperty(obj, 'functionCalls', {
    get: function() {
      // 优先尝试 GenerateContentResponse 结构
      const partsFromResponse = this.candidates?.[0]?.content?.parts;
      // 如果不是 GenerateContentResponse，尝试 Content 结构
      const parts = partsFromResponse || this.parts;

      if (!parts || !Array.isArray(parts)) return undefined;

      const calls = parts
        .filter((p: any) => p && p.functionCall)
        .map((p: any) => p.functionCall);

      return calls.length > 0 ? calls : undefined;
    },
    enumerable: false,
    configurable: true
  });
}

/**
 * 环境变量替换函数
 */
function resolveEnvVar(value: string): string {
  const envVarRegex = /\$\{([^}]+)\}|\$(\w+)/g;
  return value.replace(envVarRegex, (match, varName1, varName2) => {
    const varName = varName1 || varName2;
    return process.env[varName] || match;
  });
}

/**
 * 安全解析 JSON - 增强版
 * 专门针对流式工具调用场景优化，处理各种不完整或格式异常的 JSON
 *
 * 常见问题场景：
 * 1. 流式传输中 JSON 被截断：{"pattern": "TO  (缺少结尾)
 * 2. 模型返回空字符串或 undefined
 * 3. 模型返回非标准格式（如带有多余空格、换行）
 * 4. 嵌套 JSON 字符串（需要二次解析）
 */
function parseJSONSafe(jsonStr: string): any {
  // 处理空值
  if (!jsonStr || jsonStr === 'null' || jsonStr === 'undefined') {
    return {};
  }

  // 如果已经是对象，直接返回
  if (typeof jsonStr === 'object') {
    return jsonStr;
  }

  // 清理字符串
  let cleanStr = jsonStr.trim();

  // 处理空对象字符串
  if (cleanStr === '{}' || cleanStr === '') {
    return {};
  }

  // 第一次尝试：直接解析
  try {
    return JSON.parse(cleanStr);
  } catch (firstError) {
    // 继续尝试修复
  }

  // 修复策略 1：处理不完整的 JSON 对象
  if (cleanStr.startsWith('{') && !cleanStr.endsWith('}')) {
    const repaired = repairIncompleteJSON(cleanStr);
    if (repaired) {
      try {
        return JSON.parse(repaired);
      } catch {
        // 继续尝试其他方法
      }
    }
  }

  // 修复策略 2：处理不完整的 JSON 数组
  if (cleanStr.startsWith('[') && !cleanStr.endsWith(']')) {
    // 尝试找到最后一个完整的元素
    const lastCompleteComma = cleanStr.lastIndexOf(',');
    if (lastCompleteComma > 0) {
      const repaired = cleanStr.substring(0, lastCompleteComma) + ']';
      try {
        return JSON.parse(repaired);
      } catch {
        // 继续尝试
      }
    }
    // 尝试直接补全
    try {
      return JSON.parse(cleanStr + ']');
    } catch {
      // 继续尝试
    }
  }

  // 修复策略 3：移除尾部可能的垃圾字符
  // 有时模型会在 JSON 后附加额外内容
  const jsonEndMatch = cleanStr.match(/^(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonEndMatch) {
    try {
      return JSON.parse(jsonEndMatch[1]);
    } catch {
      // 继续尝试
    }
  }

  // 修复策略 4：处理转义问题
  // 有时 JSON 字符串中的引号没有正确转义
  try {
    // 尝试修复常见的转义问题
    const fixedEscape = cleanStr
      .replace(/([^\\])\\([^"\\/bfnrtu])/g, '$1\\\\$2')  // 修复无效转义
      .replace(/\t/g, '\\t')  // 替换实际的 tab
      .replace(/\n/g, '\\n')  // 替换实际的换行
      .replace(/\r/g, '\\r'); // 替换实际的回车
    return JSON.parse(fixedEscape);
  } catch {
    // 继续尝试
  }

  // 所有修复尝试都失败，记录错误并返回带标记的对象
  console.error(`[CustomModel] Failed to parse tool arguments after all repair attempts`);
  console.error(`[CustomModel] Original string (first 500 chars): ${jsonStr.substring(0, 500)}`);

  // 返回一个标记了解析错误的对象
  // 使用 __parseError 前缀避免与正常工具参数冲突
  return {
    __parseError: true,
    __rawArgs: jsonStr,
    __errorMessage: `Failed to parse tool arguments as JSON. Raw value: ${jsonStr.substring(0, 200)}${jsonStr.length > 200 ? '...' : ''}`
  };
}

/**
 * 尝试修复不完整的 JSON 对象
 * 使用括号匹配和引号状态追踪来找到可以安全截断的位置
 */
function repairIncompleteJSON(jsonStr: string): string | null {
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;
  let lastSafePosition = -1;
  let lastKeyValueEnd = -1;

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    switch (char) {
      case '{':
        braceCount++;
        break;
      case '}':
        braceCount--;
        if (braceCount === 0) {
          lastSafePosition = i;
        }
        break;
      case '[':
        bracketCount++;
        break;
      case ']':
        bracketCount--;
        break;
      case ',':
        // 逗号后面可能是安全的截断点（如果不在嵌套结构中）
        if (braceCount === 1 && bracketCount === 0) {
          lastKeyValueEnd = i;
        }
        break;
    }
  }

  // 如果找到了完整的 JSON，直接返回
  if (lastSafePosition > 0 && braceCount === 0) {
    return jsonStr.substring(0, lastSafePosition + 1);
  }

  // 尝试在最后一个逗号处截断并补全
  if (lastKeyValueEnd > 0) {
    const truncated = jsonStr.substring(0, lastKeyValueEnd);
    // 补全缺失的括号
    let result = truncated;
    for (let i = 0; i < braceCount; i++) {
      result += '}';
    }
    for (let i = 0; i < bracketCount; i++) {
      result += ']';
    }
    return result;
  }

  // 尝试找到最后一个完整的键值对（以 " 结尾的值）
  // 例如: {"pattern": "TODO", "path": "/src  -> 截断到 "TODO"
  const patterns = [
    /^(.*"[^"]*"\s*:\s*"[^"]*")\s*,?\s*"[^"]*"\s*:\s*"?[^"}]*$/,  // 截断到上一个完整的字符串值
    /^(.*"[^"]*"\s*:\s*\d+)\s*,?\s*"[^"]*"\s*:\s*"?[^"}]*$/,       // 截断到上一个完整的数字值
    /^(.*"[^"]*"\s*:\s*(?:true|false|null))\s*,?\s*"[^"]*"\s*:\s*"?[^"}]*$/,  // 截断到布尔/null值
  ];

  for (const pattern of patterns) {
    const match = jsonStr.match(pattern);
    if (match && match[1]) {
      return match[1] + '}';
    }
  }

  // 最后的尝试：直接补全括号
  if (braceCount > 0) {
    let result = jsonStr;
    // 如果在字符串中间被截断，先补全引号
    if (inString) {
      result += '"';
    }
    // 补全括号
    for (let i = 0; i < braceCount; i++) {
      result += '}';
    }
    return result;
  }

  return null;
}

/**
 * 创建带状态码的错误对象，便于重试逻辑判断
 */
function createHttpError(status: number, message: string, response?: Response): Error & { status: number; response?: { headers: Record<string, string> } } {
  const error = new Error(message) as Error & { status: number; response?: { headers: Record<string, string> } };
  error.status = status;

  // 尝试解析 Retry-After 头，传递给重试逻辑
  if (response) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      error.response = {
        headers: { 'retry-after': retryAfter }
      };
    }
  }

  return error;
}

/**
 * 判断是否应该重试自定义模型请求
 * 重试条件：429 限流 或 5xx 服务器错误
 */
function shouldRetryCustomModel(error: Error): boolean {
  const status = getErrorStatus(error);

  // ✅ 429 限流 - 重试
  if (status === 429) {
    console.warn(`[CustomModel] Rate limited (429), will retry with backoff...`);
    return true;
  }

  // ✅ 5xx 服务器错误 - 重试
  if (status && status >= 500 && status < 600) {
    console.warn(`[CustomModel] Server error (${status}), will retry...`);
    return true;
  }

  // ✅ 检查错误消息中的 429
  if (error.message.includes('429')) {
    console.warn(`[CustomModel] Rate limit detected in message, will retry...`);
    return true;
  }

  // ❌ 其他错误（如 4xx 客户端错误）不重试
  return false;
}



/**
 * OpenAI 格式转换工具
 */
const OpenAIConverter = {
  /**
   * 将单个 part 转换为 OpenAI content 格式
   * 支持 text 和 inlineData (图片)
   */
  partToOpenAIContent(part: any): any | null {
    if (part.text) {
      return { type: 'text', text: part.text };
    }
    if (part.inlineData) {
      // 转换 Gemini inlineData 格式为 OpenAI image_url 格式
      const { mimeType, data } = part.inlineData;
      return {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${data}`,
        },
      };
    }
    return null;
  },

  contentsToMessages(contents: any[]): any[] {
    const messages: any[] = [];
    let pendingReasoning = '';

    for (const content of contents) {
      const parts = content.parts || [];
      const role = content.role === MESSAGE_ROLES.MODEL ? 'assistant' : 'user';

      // 1. 检查是否为纯思考消息：
      // 在历史中，我们把流式输出的多个 reasoning 块通过 appendReasoningToOutput 聚合成纯 reasoning Content。
      // 它通常只有 parts 且都是带 reasoning 字段的对象。
      const isPureReasoning = role === 'assistant' && parts.length > 0 && parts.every((p: any) => p.reasoning !== undefined);
      if (isPureReasoning) {
        pendingReasoning += parts.map((p: any) => p.reasoning).join('');
        continue; // 过滤纯思考消息，使其不作为独立对话发送（避免 API 报错）
      }

      // 如果遇到用户消息，说明当前助手回合结束。如果还没用掉 pendingReasoning，则清空（未调用工具时不拼接）
      if (role === 'user') {
        pendingReasoning = '';
      }

      // 2. 处理包含工具调用的消息
      if (parts.some((p: any) => p.functionCall)) {
        const msg: any = {
          role,
          content: null,
          tool_calls: parts
            .filter((p: any) => p.functionCall)
            .map((p: any, idx: number) => ({
              id: p.functionCall.id || `call_${Date.now()}_${idx}`,
              type: 'function',
              function: {
                name: p.functionCall.name,
                arguments: typeof p.functionCall.args === 'string'
                  ? p.functionCall.args
                  : JSON.stringify(p.functionCall.args || {}),
              },
            })),
        };

        // DeepSeek 思考模式规则：在进行了工具调用的轮次中，reasoning_content 必须随 assistant 消息回传。
        if (pendingReasoning) {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = ''; // 消费后清除
        }

        messages.push(msg);
        continue;
      }

      // 3. 处理工具执行结果消息
      if (parts.some((p: any) => p.functionResponse)) {
        const functionResponseParts = parts.filter((p: any) => p.functionResponse);
        const toolMessages = functionResponseParts.map((p: any) => ({
          role: 'tool',
          tool_call_id: p.functionResponse.id || `call_${p.functionResponse.name}`,
          content: typeof p.functionResponse.response === 'string'
            ? p.functionResponse.response
            : JSON.stringify(p.functionResponse.response || {}),
        }));
        messages.push(...toolMessages);
        continue;
      }

      // 4. 检查是否包含图片内容
      const hasImageContent = parts.some((p: any) => p.inlineData);

      if (hasImageContent) {
        const contentParts = parts
          .map((part: any) => OpenAIConverter.partToOpenAIContent(part))
          .filter(Boolean);

        const msg: any = {
          role,
          content: contentParts,
        };
        messages.push(msg);
        continue;
      }

      // 5. 纯文本内容
      const textContent = parts.map((part: any) => part.text || '').join('\n');
      const msg: any = {
        role,
        content: textContent,
      };
      messages.push(msg);
    }

    return messages;
  },

  toolsToOpenAITools(tools: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.flatMap((tool: any) => {
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        return tool.functionDeclarations.map((fd: any) => ({
          type: 'function',
          function: {
            name: fd.name,
            description: fd.description,
            parameters: fd.parameters,
          },
        }));
      }
      return [{
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }];
    });
  },

  mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'stop': return FinishReason.STOP;
      case 'length': return FinishReason.MAX_TOKENS;
      case 'content_filter': return FinishReason.SAFETY;
      case 'tool_calls': return FinishReason.STOP;
      default: return FinishReason.OTHER;
    }
  }
};

/**
 * Anthropic 格式转换工具
 * 完整支持 Anthropic Messages API 格式，包括：
 * - system 数组格式（带 cache_control）
 * - extended thinking 配置
 * - 完整的 input_schema（含 additionalProperties）
 * @see https://docs.anthropic.com/en/api/messages
 */
const AnthropicConverter = {
  /**
   * 将 Gemini 格式内容转换为 Anthropic 格式
   * 自动添加 cache_control 以利用 Anthropic prompt caching：
   * - 所有 system 消息块添加 cache_control: { type: 'ephemeral' }
   * - 用户消息的最后一个文本块添加 cache_control: { type: 'ephemeral' }
   * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
   */
  contentsToAnthropic(contents: any[]): { messages: any[], system?: any[] } {
    const messages: any[] = [];
    const systemBlocks: any[] = [];

    for (const content of contents) {
      const parts = content.parts || [];

      if (content.role === 'system') {
        // 转换为 Anthropic system 数组格式
        for (const p of parts) {
          if (p.text) {
            const block: any = { type: 'text', text: p.text };
            // 🆕 自动添加 cache_control（与 Claude Code 行为一致）
            block.cache_control = p.cache_control || { type: 'ephemeral' };
            systemBlocks.push(block);
          }
        }
        continue;
      }

      const role = content.role === MESSAGE_ROLES.MODEL ? 'assistant' : 'user';
      const anthropicParts: any[] = [];

      for (const part of parts) {
        if (part.text) {
          const textBlock: any = { type: 'text', text: part.text };
          // 透传已有的 cache_control（后续会为最后一个文本块自动添加）
          if (part.cache_control) {
            textBlock.cache_control = part.cache_control;
          }
          anthropicParts.push(textBlock);
        }
        if (part.inlineData) {
          // 转换 Gemini inlineData 格式为 Anthropic image 格式
          anthropicParts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.inlineData.mimeType,
              data: part.inlineData.data,
            },
          });
        }
        if (part.functionCall) {
          anthropicParts.push({
            type: 'tool_use',
            id: part.functionCall.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          });
        }
        if (part.functionResponse) {
          anthropicParts.push({
            type: 'tool_result',
            tool_use_id: part.functionResponse.id || `toolu_${part.functionResponse.name}`,
            content: typeof part.functionResponse.response === 'string'
              ? part.functionResponse.response
              : JSON.stringify(part.functionResponse.response || {}),
          });
        }
      }

      if (anthropicParts.length > 0) {
        messages.push({ role, content: anthropicParts });
      }
    }

    if (messages.length > 0 && messages[0].role === 'assistant') {
      messages.unshift({ role: 'user', content: '...' });
    }

    const merged: any[] = [];
    for (const msg of messages) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === msg.role) {
        const prevContent = Array.isArray(prev.content) ? prev.content : [{type:'text', text: prev.content}];
        const msgContent = Array.isArray(msg.content) ? msg.content : [{type:'text', text: msg.content}];
        prev.content = [...prevContent, ...msgContent];
      } else {
        merged.push(msg);
      }
    }

    // 🆕 为最后一条用户消息的最后一个文本块添加 cache_control
    // 与 Claude Code 行为一致，利用 prompt caching 减少 token 消耗
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i].role === 'user' && Array.isArray(merged[i].content)) {
        const content = merged[i].content;
        // 找到最后一个文本块
        for (let j = content.length - 1; j >= 0; j--) {
          if (content[j].type === 'text' && !content[j].cache_control) {
            content[j].cache_control = { type: 'ephemeral' };
            break;
          }
        }
        break; // 只处理最后一条用户消息
      }
    }

    return {
      messages: merged,
      system: systemBlocks.length > 0 ? systemBlocks : undefined
    };
  },

  /**
   * 将工具定义转换为 Anthropic 格式
   * 完整支持 input_schema（含 additionalProperties: false）
   */
  toolsToAnthropicTools(tools: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const cleanSchema = (schema: any, isRoot: boolean = false): any => {
      if (!schema || typeof schema !== 'object') return schema;
      const cleaned: any = {};
      const validFields = ['type', 'properties', 'required', 'items', 'enum', 'description', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not'];
      for (const key of validFields) {
        if (schema[key] !== undefined) {
          if (key === 'type' && typeof schema[key] === 'string') cleaned[key] = schema[key].toLowerCase();
          else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(key)) {
            const val = parseFloat(schema[key]);
            if (!isNaN(val)) cleaned[key] = val;
          }
          else if (key === 'properties' && typeof schema[key] === 'object') {
            cleaned[key] = {};
            for (const k in schema[key]) cleaned[key][k] = cleanSchema(schema[key][k], false);
          } else if (key === 'items') cleaned[key] = cleanSchema(schema[key], false);
          else cleaned[key] = schema[key];
        }
      }
      return cleaned;
    };

    return tools.flatMap((tool: any) => {
      const decls = tool.functionDeclarations || [tool];
      return decls.map((fd: any) => {
        const cleaned = cleanSchema(fd.parameters || {}, true);
        return {
          name: fd.name,
          description: fd.description || '',
          input_schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: cleaned.properties || {},
            ...(cleaned.required && { required: cleaned.required }),
            // 🔧 关键：添加 additionalProperties: false 以匹配 Claude Code 的行为
            additionalProperties: false,
          },
        };
      });
    });
  },

  mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'end_turn': return FinishReason.STOP;
      case 'max_tokens': return FinishReason.MAX_TOKENS;
      case 'tool_use': return FinishReason.STOP;
      default: return FinishReason.OTHER;
    }
  }
};

/**
 * OpenAI 兼容模型单次调用
 * 使用指数退避重试策略处理 429 和 5xx 错误
 */
export async function callOpenAICompatibleModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): Promise<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const url = `${baseUrl}/chat/completions`;

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const requestBody: any = {
    model: modelConfig.modelId,
    messages: OpenAIConverter.contentsToMessages(request.contents),
    tools: OpenAIConverter.toolsToOpenAITools(request.config?.tools),
    stream: false,
  };

  const modelIdLower = modelConfig.modelId.toLowerCase();
  const isGLM = modelIdLower.includes('glm');

  if (isGLM) {
    // 智谱 GLM 系列思维模式适配
    requestBody.extra_body = {
      thinking: thinkingConfig.mode === 'off'
        ? { type: 'disabled' }
        : { type: 'enabled', clear_thinking: false } // 保留式思考 (Preserved Thinking)
    };
  } else if (thinkingConfig.mode === 'off') {
    requestBody.reasoning_effort = 'low'; // 强制降低思考强度以节省 token
  } else {
    // 配置标准 OpenAI 兼容的 reasoning_effort 参数 (支持 o1/o3/gpt-5.5/qwen 等)
    const openaiEffort = effortToOpenAIEffort(thinkingConfig.effort);
    if (openaiEffort) {
      requestBody.reasoning_effort = openaiEffort;
    }
  }

  // 使用指数退避重试包装 API 调用
  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(response.status, `OpenAI API error (${response.status}): ${errorText}`, response);
      }

      const data = await response.json();
      const choice = data.choices[0];
      const message = choice.message;

      const parts: any[] = [];
      if (message.reasoning_content) {
        parts.push({ reasoning: message.reasoning_content });
      }
      if (message.content) parts.push({ text: message.content });
      if (message.tool_calls) {
        for (const tc of message.tool_calls) {
          if (tc.type === 'function') {
            parts.push({
              functionCall: {
                name: tc.function.name?.trim() || tc.function.name,
                args: parseJSONSafe(tc.function.arguments),
                id: tc.id,
              },
            });
          }
        }
      }

      // 🔧 OpenAI prompt caching：缓存信息在 usage.prompt_tokens_details.cached_tokens
      // 参考：https://platform.openai.com/docs/guides/prompt-caching
      const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens || 0;
      const promptTokens = data.usage?.prompt_tokens || 0;

      const result = {
        candidates: [{
          content: { role: MESSAGE_ROLES.MODEL, parts: parts.length ? parts : [{ text: '' }] },
          finishReason: OpenAIConverter.mapFinishReason(choice.finish_reason),
          index: 0,
        }],
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: data.usage?.completion_tokens || 0,
          totalTokenCount: data.usage?.total_tokens || 0,
          // 🔧 OpenAI prompt caching support
          // OpenAI 使用 prompt_tokens_details.cached_tokens 表示缓存命中的 token
          // 映射到我们的字段名以保持与 geminiChat.ts 兼容
          ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
          // OpenAI 不区分 cache creation，只有 cache read
          // uncachedInputTokens = promptTokens - cachedTokens
          uncachedInputTokens: promptTokens - cachedTokens,
        } as any,
      };
      addFunctionCallsGetter(result);
      return result as GenerateContentResponse;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );
}

/**
 * OpenAI Responses API 格式转换工具
 * Responses API 使用 input/output 而非 messages/choices
 * @see https://platform.openai.com/docs/api-reference/responses
 */
const OpenAIResponsesConverter = {
  /**
   * 将内部内容格式转换为 Responses API 的 input 格式
   * Responses API 使用扁平化的 items 数组，与 Chat Completions 的 messages 格式不同：
   * - 文本消息: { role: "user"|"assistant"|"system", content: "..." }
   * - 函数调用: { type: "function_call", call_id: "...", name: "...", arguments: "..." }
   * - 函数输出: { type: "function_call_output", call_id: "...", output: "..." }
   */
  contentsToInput(contents: any[]): any[] {
    const items: any[] = [];

    for (const content of contents) {
      const parts = content.parts || [];
      const role = content.role === MESSAGE_ROLES.MODEL ? 'assistant'
                 : content.role === 'system' ? 'system'
                 : 'user';

      // 收集当前 content 的各类部分
      const textParts: string[] = [];
      const functionCalls: any[] = [];
      const functionResponses: any[] = [];
      const imageParts: any[] = [];

      for (const part of parts) {
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        } else if (part.functionResponse) {
          functionResponses.push(part.functionResponse);
        } else if (part.text) {
          textParts.push(part.text);
        } else if (part.inlineData) {
          imageParts.push(part.inlineData);
        }
      }

      // 如果有文本或图片，先输出文本消息
      if (textParts.length > 0 || imageParts.length > 0) {
        if (imageParts.length > 0) {
          // 混合内容：文本 + 图片
          const contentParts: any[] = [];
          for (const text of textParts) {
            contentParts.push({ type: 'input_text', text });
          }
          for (const img of imageParts) {
            contentParts.push({
              type: 'input_image',
              image_url: `data:${img.mimeType};base64,${img.data}`,
            });
          }
          items.push({ role, content: contentParts });
        } else {
          items.push({ role, content: textParts.join('\n') });
        }
      }

      // 函数调用作为独立的 function_call items（不包裹在 message 中）
      for (const fc of functionCalls) {
        items.push({
          type: 'function_call',
          call_id: fc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: fc.name,
          arguments: typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args || {}),
        });
      }

      // 函数响应作为独立的 function_call_output items
      for (const fr of functionResponses) {
        items.push({
          type: 'function_call_output',
          call_id: fr.id || `call_${fr.name}`,
          output: typeof fr.response === 'string'
            ? fr.response
            : JSON.stringify(fr.response || {}),
        });
      }
    }

    return items;
  },

  /**
   * JSON Schema 中必须为整数的关键字集合
   * OpenAI Responses API 严格校验这些字段的类型，不接受字符串形式的数字
   */
  INTEGER_SCHEMA_KEYWORDS: new Set([
    'minLength', 'maxLength', 'minItems', 'maxItems',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'minProperties', 'maxProperties', 'multipleOf',
  ]),

  /**
   * 清理 JSON Schema，使其兼容 OpenAI Responses API 的严格校验：
   * 1. 将 Google GenAI 的大写类型（如 "BOOLEAN", "STRING"）转为小写（"boolean", "string"）
   * 2. 将数值型 Schema 关键字（如 minLength, minItems）从字符串强制转为数字
   *    （例如 minLength: '1' → minLength: 1）
   * 3. 移除 Responses API 不支持的非标准 Schema 字段（如 $schema）
   */
  cleanSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map((item: any) => OpenAIResponsesConverter.cleanSchema(item));

    const cleaned: any = {};
    for (const key of Object.keys(schema)) {
      if (key === 'type' && typeof schema[key] === 'string') {
        // 大写类型转小写: "STRING" → "string", "BOOLEAN" → "boolean"
        cleaned[key] = schema[key].toLowerCase();
      } else if (OpenAIResponsesConverter.INTEGER_SCHEMA_KEYWORDS.has(key)) {
        // 数值型关键字强制转为数字: '1' → 1
        const numVal = Number(schema[key]);
        if (!isNaN(numVal)) {
          cleaned[key] = numVal;
        }
        // 如果无法转为数字则丢弃该字段，避免 API 报错
      } else if (key === 'properties' && typeof schema[key] === 'object') {
        cleaned[key] = {};
        for (const k of Object.keys(schema[key])) {
          cleaned[key][k] = OpenAIResponsesConverter.cleanSchema(schema[key][k]);
        }
      } else if (key === 'items') {
        cleaned[key] = OpenAIResponsesConverter.cleanSchema(schema[key]);
      } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(schema[key])) {
        cleaned[key] = schema[key].map((item: any) => OpenAIResponsesConverter.cleanSchema(item));
      } else if (key === 'default') {
        // default 值根据 type 做基本类型转换
        cleaned[key] = schema[key];
      } else {
        cleaned[key] = schema[key];
      }
    }
    return cleaned;
  },

  /**
   * 将工具定义转换为 Responses API 格式
   * Responses API 使用 type: "function" 包装，内部标记 (internally-tagged)
   * 注意：Responses API 的 schema 校验比 Chat Completions 更严格，
   * 必须将 Google GenAI 的大写类型转为小写
   */
  toolsToResponsesTools(tools: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.flatMap((tool: any) => {
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        return tool.functionDeclarations.map((fd: any) => ({
          type: 'function',
          name: fd.name,
          description: fd.description,
          parameters: OpenAIResponsesConverter.cleanSchema(fd.parameters),
          strict: false, // Responses API defaults to strict: true, set false for compatibility
        }));
      }
      return [{
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: OpenAIResponsesConverter.cleanSchema(tool.parameters),
        strict: false,
      }];
    });
  },

  /**
   * 从 Responses API 的 output items 中提取 parts
   */
  outputToParts(output: any[]): any[] {
    const parts: any[] = [];
    if (!output || !Array.isArray(output)) return parts;

    for (const item of output) {
      if (item.type === 'message') {
        // message item contains content array
        if (item.content && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text') {
              parts.push({ text: c.text });
            }
          }
        }
      } else if (item.type === 'function_call') {
        parts.push({
          functionCall: {
            name: item.name?.trim() || item.name,
            args: parseJSONSafe(item.arguments || '{}'),
            id: item.call_id || item.id,
          },
        });
      }
    }
    return parts;
  },

  mapFinishReason(status: string): FinishReason {
    switch (status) {
      case 'completed': return FinishReason.STOP;
      case 'incomplete': return FinishReason.MAX_TOKENS;
      case 'failed': return FinishReason.OTHER;
      default: return FinishReason.OTHER;
    }
  }
};

/**
 * OpenAI Responses API 单次调用
 * 使用 POST /responses 端点
 * 使用指数退避重试策略处理 429 和 5xx 错误
 */
export async function callOpenAIResponsesModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): Promise<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const url = `${baseUrl}/responses`;

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const requestBody: any = {
    model: modelConfig.modelId,
    input: OpenAIResponsesConverter.contentsToInput(request.contents),
    tools: OpenAIResponsesConverter.toolsToResponsesTools(request.config?.tools),
    store: false, // Don't store responses on the server
  };

  if (thinkingConfig.mode === 'off') {
    requestBody.reasoning = { effort: 'low' }; // 最低限度思考以省 token
  } else {
    const openaiEffort = effortToOpenAIEffort(thinkingConfig.effort);
    if (openaiEffort) {
      requestBody.reasoning = { effort: openaiEffort };
    }
  }

  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(response.status, `OpenAI Responses API error (${response.status}): ${errorText}`, response);
      }

      const data = await response.json();
      const parts = OpenAIResponsesConverter.outputToParts(data.output);

      const cachedTokens = data.usage?.input_tokens_details?.cached_tokens || 0;
      const promptTokens = data.usage?.input_tokens || 0;
      const outputTokens = data.usage?.output_tokens || 0;

      const result = {
        candidates: [{
          content: { role: MESSAGE_ROLES.MODEL, parts: parts.length ? parts : [{ text: '' }] },
          finishReason: OpenAIResponsesConverter.mapFinishReason(data.status),
          index: 0,
        }],
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: (promptTokens + outputTokens) || data.usage?.total_tokens || 0,
          ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
          uncachedInputTokens: promptTokens - cachedTokens,
        } as any,
      };
      addFunctionCallsGetter(result);
      return result as GenerateContentResponse;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );
}

/**
 * OpenAI Responses API 流式调用
 * 使用 POST /responses 端点 + stream: true
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 */
export async function* callOpenAIResponsesModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): AsyncGenerator<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const requestBody: any = {
    model: modelConfig.modelId,
    input: OpenAIResponsesConverter.contentsToInput(request.contents),
    tools: OpenAIResponsesConverter.toolsToResponsesTools(request.config?.tools),
    stream: true,
    store: false,
  };

  if (thinkingConfig.mode === 'off') {
    requestBody.reasoning = { effort: 'low' }; // 最低限度思考以省 token
  } else {
    const openaiEffort = effortToOpenAIEffort(thinkingConfig.effort);
    if (openaiEffort) {
      requestBody.reasoning = { effort: openaiEffort };
    }
  }

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(res.status, `OpenAI Responses Stream error (${res.status}): ${errorText}`, res);
      }

      return res;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  // Aggregate function call arguments across deltas
  const aggregatedFunctionCalls: Map<string, { callId: string, name: string, args: string }> = new Map();

  const flushFunctionCalls = function* (): Generator<GenerateContentResponse> {
    if (aggregatedFunctionCalls.size === 0) return;
    const toolParts = Array.from(aggregatedFunctionCalls.values()).map(fc => ({
      functionCall: {
        name: fc.name || 'unknown_tool',
        args: parseJSONSafe(fc.args),
        id: fc.callId || `call_${Date.now()}`
      }
    }));
    const content = { role: MESSAGE_ROLES.MODEL, parts: toolParts };
    const resp = {
      candidates: [{
        content,
        finishReason: FinishReason.STOP,
        index: 0
      }]
    };
    addFunctionCallsGetter(resp);
    addFunctionCallsGetter(content);
    yield resp as GenerateContentResponse;
    aggregatedFunctionCalls.clear();
  };

  try {
    let isDone = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        isDone = true;
      }

      if (!done) {
        buffer += decoder.decode(value, { stream: true });
      } else {
        buffer += decoder.decode(undefined, { stream: false });
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          yield* flushFunctionCalls();
          isDone = true;
          break;
        }

        try {
          const event = JSON.parse(dataStr);

          // response.output_text.delta - text content streaming
          if (event.type === 'response.output_text.delta') {
            const text = event.delta || '';
            if (text) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ text }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as GenerateContentResponse;
            }
          }

          // response.function_call_arguments.delta - function call argument streaming
          if (event.type === 'response.function_call_arguments.delta') {
            const itemId = event.item_id || 'default';
            let fc = aggregatedFunctionCalls.get(itemId);
            if (!fc) {
              fc = { callId: '', name: '', args: '' };
              aggregatedFunctionCalls.set(itemId, fc);
            }
            if (event.delta) fc.args += event.delta;
          }

          // response.output_item.added - track new function call items
          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            const itemId = event.item.id || 'default';
            aggregatedFunctionCalls.set(itemId, {
              callId: event.item.call_id || event.item.id || `call_${Date.now()}`,
              name: event.item.name?.trim() || '',
              args: ''
            });
          }

          // response.function_call_arguments.done - function call complete
          if (event.type === 'response.function_call_arguments.done') {
            const itemId = event.item_id || 'default';
            const fc = aggregatedFunctionCalls.get(itemId);
            if (fc) {
              // Use the final arguments if provided
              if (event.arguments) {
                fc.args = event.arguments;
              }
              // Yield completed function call
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: fc.name, args: parseJSONSafe(fc.args), id: fc.callId } }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as GenerateContentResponse;
              aggregatedFunctionCalls.delete(itemId);
            }
          }

          // response.completed - final event with usage
          if (event.type === 'response.completed' && event.response) {
            const usage = event.response.usage;
            if (usage) {
              const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
              const promptTokens = usage.input_tokens || 0;

              yield {
                candidates: [],
                usageMetadata: {
                  promptTokenCount: promptTokens,
                  candidatesTokenCount: usage.output_tokens || 0,
                  totalTokenCount: (promptTokens + (usage.output_tokens || 0)) || usage.total_tokens || 0,
                  ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
                  uncachedInputTokens: promptTokens - cachedTokens,
                }
              } as any;
            }
          }
        } catch (e) {}
      }

      if (isDone) {
        yield* flushFunctionCalls();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 检查是否应该启用 Extended Thinking
 * 对于 Anthropic 协议，默认启用 thinking（让服务端决定是否支持）
 * 不支持的模型会忽略此参数，因此统一启用更简单通用
 * @see https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 */
function shouldEnableThinkingByDefault(): boolean {
  // 对于所有 Anthropic 协议的模型，默认启用 thinking
  // 如果模型不支持，服务端会自动忽略此参数
  return true;
}

/**
 * Anthropic 模型单次调用
 * 使用指数退避重试策略处理 429 和 5xx 错误
 * 支持 extended thinking 配置
 */
export async function callAnthropicModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): Promise<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const { messages, system } = AnthropicConverter.contentsToAnthropic(request.contents);

  const requestBody: any = {
    model: modelConfig.modelId,
    messages,
    tools: AnthropicConverter.toolsToAnthropicTools(request.config?.tools),
    max_tokens: modelConfig.maxTokens || 4096,
  };

  // 添加 system（数组格式，带 cache_control 支持）
  if (system && system.length > 0) {
    requestBody.system = system;
  }

  // 🆕 Extended Thinking 智能启用与力度调控策略：
  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const isThinkingEnabled = thinkingConfig.mode === 'on' ||
    (thinkingConfig.mode === 'auto' && shouldEnableThinkingByDefault());

  if (isThinkingEnabled) {
    // 优先使用模型配置文件中的 maxTokens，若未配置且开启思考时才建议使用 32000 作为默认大输出窗口
    const maxTokens = modelConfig.maxTokens || 32000;

    // 如果是 Claude 4.6 系列（modelId 包含 'claude-4-6' 或 '-4.6'），或者用户显式指定了特定的 effort，
    // 我们采用现代的 "adaptive" + "effort" 模式
    const isModernClaude46 = modelConfig.modelId.includes('claude-4-6') ||
      modelConfig.modelId.includes('-4.6') ||
      (thinkingConfig.effort !== undefined && thinkingConfig.effort !== 'auto');

    if (isModernClaude46 && thinkingConfig.budgetTokens === undefined) {
      const effort = effortToAnthropicEffort(thinkingConfig.effort) || 'high'; // 默认为 high
      requestBody.thinking = {
        type: 'adaptive',
        effort,
      };
    } else {
      // 否则回退到传统的 "enabled" + budget_tokens（支持 Sonnet 3.7 / Sonnet 3.5 兼容等）
      const budgetTokens = thinkingConfig.budgetTokens !== undefined
        ? thinkingConfig.budgetTokens
        : effortToAnthropicBudget(thinkingConfig.effort);

      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(maxTokens - 1, budgetTokens),
      };
    }
    // 写入请求体中，尊重用户配置文件，仅在空缺时用 maxTokens
    requestBody.max_tokens = modelConfig.maxTokens || maxTokens;
  }

  // 使用指数退避重试包装 API 调用
  return retryWithBackoff(
    async () => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(response.status, `Anthropic error (${response.status}): ${errorText}`, response);
      }

      const data = await response.json();
      const parts = data.content.map((c: any) => {
        if (c.type === 'text') return { text: c.text };
        if (c.type === 'tool_use') return { functionCall: { name: c.name?.trim() || c.name, args: c.input, id: c.id } };
        // 🆕 支持 thinking 内容块 - 映射为 reasoning 格式以便 UI 显示
        // Anthropic 的 thinking 块包含模型的内部推理过程，类似于 Gemini 的 reasoning 字段
        if (c.type === 'thinking') return { reasoning: c.thinking };
        return null;
      }).filter(Boolean);

      // 🔧 计算真正的总输入 token：
      // Anthropic 的 input_tokens 只是非缓存的直接输入，实际总输入需要加上缓存 token
      const uncachedInputTokens = data.usage?.input_tokens || 0;
      const cacheCreationTokens = data.usage?.cache_creation_input_tokens || 0;
      const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;
      const actualPromptTokens = uncachedInputTokens + cacheCreationTokens + cacheReadTokens;
      const outputTokens = data.usage?.output_tokens || 0;

      const result = {
        candidates: [{
          content: { role: MESSAGE_ROLES.MODEL, parts: parts.length ? parts : [{ text: '' }] },
          finishReason: AnthropicConverter.mapFinishReason(data.stop_reason),
          index: 0,
        }],
        usageMetadata: {
          // promptTokenCount 应该反映实际处理的总输入 token（包括缓存）
          promptTokenCount: actualPromptTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: actualPromptTokens + outputTokens,
          // 🔧 Claude prompt caching 详细信息
          // 字段名与 geminiChat.ts 中读取的一致（不带 Count 后缀）
          // - cacheCreationInputTokens: 本次写入缓存的 token（1.25x 价格）
          // - cacheReadInputTokens: 从缓存读取的 token（0.1x 价格，便宜 90%）
          // - uncachedInputTokens: 非缓存的直接输入 token
          ...(cacheCreationTokens && { cacheCreationInputTokens: cacheCreationTokens }),
          ...(cacheReadTokens != null && { cacheReadInputTokens: cacheReadTokens }),
          uncachedInputTokens: uncachedInputTokens,
        } as any,
      };
      addFunctionCallsGetter(result);
      return result as GenerateContentResponse;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );
}

/**
 * OpenAI 兼容模型流式调用
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 */
export async function* callOpenAICompatibleModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): AsyncGenerator<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const requestBody: any = {
    model: modelConfig.modelId,
    messages: OpenAIConverter.contentsToMessages(request.contents),
    tools: OpenAIConverter.toolsToOpenAITools(request.config?.tools),
    stream: true,
    stream_options: { include_usage: true } // 请求包含 usage 信息
  };

  const modelIdLower = modelConfig.modelId.toLowerCase();
  const isGLM = modelIdLower.includes('glm');

  if (isGLM) {
    // 智谱 GLM 系列思维模式适配
    requestBody.extra_body = {
      thinking: thinkingConfig.mode === 'off'
        ? { type: 'disabled' }
        : { type: 'enabled', clear_thinking: false } // 保留式思考 (Preserved Thinking)
    };
  } else if (thinkingConfig.mode === 'off') {
    requestBody.reasoning_effort = 'low'; // 强制降低思考强度以节省 token
  } else {
    // 配置标准 OpenAI 兼容的 reasoning_effort 参数 (支持 o1/o3/gpt-5.5/qwen 等)
    const openaiEffort = effortToOpenAIEffort(thinkingConfig.effort);
    if (openaiEffort) {
      requestBody.reasoning_effort = openaiEffort;
    }
  }

  // 使用指数退避重试包装初始连接
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(res.status, `OpenAI Stream error (${res.status}): ${errorText}`, res);
      }

      return res;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  // 用于聚合流式工具调用
  const aggregatedTools: Map<number, { id: string, name: string, args: string }> = new Map();

  const flushTools = function* (): Generator<GenerateContentResponse> {
    if (aggregatedTools.size === 0) return;
    const toolParts = Array.from(aggregatedTools.values()).map(at => ({
      functionCall: {
        name: at.name || 'unknown_tool',
        args: parseJSONSafe(at.args),
        id: at.id || `call_${Date.now()}`
      }
    }));
    const content = { role: MESSAGE_ROLES.MODEL, parts: toolParts };
    const resp = {
      candidates: [{
        content,
        finishReason: FinishReason.STOP,
        index: 0
      }]
    };
    addFunctionCallsGetter(resp);
    addFunctionCallsGetter(content);
    yield resp as GenerateContentResponse;
    aggregatedTools.clear();
  };

  try {
    let isDone = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        isDone = true;
      }

      if (!done) {
        buffer += decoder.decode(value, { stream: true });
      } else {
        // 流结束，使用最终解码
        buffer += decoder.decode(undefined, { stream: false });
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          // OpenAI 明确表示流结束，此时应该 flush 所有待完成的工具调用
          yield* flushTools();
          isDone = true;
          break;
        }

        try {
          const chunk = JSON.parse(dataStr);
          const choice = chunk.choices?.[0];

          if (choice) {
            const delta = choice.delta;

            // 处理思考内容 - 立即 yield
            if (delta?.reasoning_content) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ reasoning: delta.reasoning_content }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as any as GenerateContentResponse;
            }

            // 处理文本内容 - 立即 yield
            if (delta?.content) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ text: delta.content }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as any as GenerateContentResponse;
            }

            // 聚合工具调用 - 不立即 yield，等待完全接收
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                let tool = aggregatedTools.get(idx);
                if (!tool) {
                  tool = { id: '', name: '', args: '' };
                  aggregatedTools.set(idx, tool);
                }
                if (tc.id) tool.id = tc.id;
                if (tc.function?.name) tool.name = tc.function.name.trim();
                if (tc.function?.arguments) tool.args += tc.function.arguments;
              }
            }

            // 只在流结束时 flush，不在 finish_reason 中间 flush
            // 这与 Claude 的行为一致，防止不完整的工具调用被识别
          }

          if (chunk.usage) {
            // 🔧 OpenAI prompt caching：缓存信息在 usage.prompt_tokens_details.cached_tokens
            const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
            const promptTokens = chunk.usage.prompt_tokens || 0;

            yield {
              candidates: [],
              usageMetadata: {
                promptTokenCount: promptTokens,
                candidatesTokenCount: chunk.usage.completion_tokens || 0,
                totalTokenCount: chunk.usage.total_tokens || 0,
                // 🔧 OpenAI prompt caching support
                // OpenAI 使用 prompt_tokens_details.cached_tokens 表示缓存命中的 token
                // 映射到我们的字段名以保持与 geminiChat.ts 兼容
                ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
                // OpenAI 不区分 cache creation，只有 cache read
                uncachedInputTokens: promptTokens - cachedTokens,
              }
            } as any;
          }
        } catch (e) {}
      }

      if (isDone) {
        // 在流完全结束时，flush 所有待完成的工具调用
        yield* flushTools();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Anthropic 模型流式调用
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 * 支持 extended thinking 配置
 */
export async function* callAnthropicModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): AsyncGenerator<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const { messages, system } = AnthropicConverter.contentsToAnthropic(request.contents);

  const requestBody: any = {
    model: modelConfig.modelId,
    messages,
    tools: AnthropicConverter.toolsToAnthropicTools(request.config?.tools),
    max_tokens: modelConfig.maxTokens || 4096,
    stream: true,
  };

  // 添加 system（数组格式，带 cache_control 支持）
  if (system && system.length > 0) {
    requestBody.system = system;
  }

  // 🆕 Extended Thinking 智能启用与力度调控策略（流式调用）：
  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const isThinkingEnabled = thinkingConfig.mode === 'on' ||
    (thinkingConfig.mode === 'auto' && shouldEnableThinkingByDefault());

  if (isThinkingEnabled) {
    // 优先使用模型配置文件中的 maxTokens，若未配置且开启思考时才建议使用 32000 作为默认大输出窗口
    const maxTokens = modelConfig.maxTokens || 32000;

    // 如果是 Claude 4.6 系列（modelId 包含 'claude-4-6' 或 '-4.6'），或者用户显式指定了特定的 effort，
    // 我们采用现代的 "adaptive" + "effort" 模式
    const isModernClaude46 = modelConfig.modelId.includes('claude-4-6') ||
      modelConfig.modelId.includes('-4.6') ||
      (thinkingConfig.effort !== undefined && thinkingConfig.effort !== 'auto');

    if (isModernClaude46 && thinkingConfig.budgetTokens === undefined) {
      const effort = effortToAnthropicEffort(thinkingConfig.effort) || 'high'; // 默认为 high
      requestBody.thinking = {
        type: 'adaptive',
        effort,
      };
    } else {
      // 否则回退到传统的 "enabled" + budget_tokens（支持 Sonnet 3.7 / Sonnet 3.5 兼容等）
      const budgetTokens = thinkingConfig.budgetTokens !== undefined
        ? thinkingConfig.budgetTokens
        : effortToAnthropicBudget(thinkingConfig.effort);

      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(maxTokens - 1, budgetTokens),
      };
    }
    // 写入请求体中，尊重用户配置文件，仅在空缺时用 maxTokens
    requestBody.max_tokens = modelConfig.maxTokens || maxTokens;
  }

  // 使用指数退避重试包装初始连接
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(res.status, `Anthropic Stream error (${res.status}): ${errorText}`, res);
      }

      return res;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  const aggregatedTools: Map<number, { id: string, name: string, args: string }> = new Map();
  // 🆕 用于聚合 thinking 内容块（流式累积后一次性发送）
  const aggregatedThinking: Map<number, string> = new Map();

  // 用于累积 token 使用统计
  // 🔧 修复：缓存 token 来自 message_start（初始值），output_tokens 来自 message_delta（累加）
  let inputTokens = 0;
  let totalOutputTokens = 0;
  // 缓存相关 token（从 message_start 获取，不累加）
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);

        try {
          const chunk = JSON.parse(dataStr);
          const idx = chunk.index ?? 0;

          if (chunk.type === 'content_block_start') {
            if (chunk.content_block?.type === 'tool_use') {
              aggregatedTools.set(idx, {
                id: chunk.content_block.id,
                name: chunk.content_block.name?.trim() || chunk.content_block.name,
                args: ''
              });
            } else if (chunk.content_block?.type === 'thinking') {
              // 🆕 开始聚合 thinking 内容块
              aggregatedThinking.set(idx, chunk.content_block.thinking || '');
            }
          } else if (chunk.type === 'content_block_delta') {
            if (chunk.delta?.type === 'text_delta') {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ text: chunk.delta.text }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as any;
            } else if (chunk.delta?.type === 'input_json_delta') {
              const tool = aggregatedTools.get(idx);
              if (tool) tool.args += chunk.delta.partial_json;
            } else if (chunk.delta?.type === 'thinking_delta') {
              // 🆕 实时流式输出 thinking 内容，让 UI 能显示模型思考过程
              const thinkingChunk = chunk.delta.thinking || '';
              if (thinkingChunk) {
                const content = { role: MESSAGE_ROLES.MODEL, parts: [{ reasoning: thinkingChunk }] } as any;
                const resp = { candidates: [{ content, index: 0 }] } as any;
                addFunctionCallsGetter(resp);
                addFunctionCallsGetter(content);
                yield resp;
              }
              // 同时累积完整内容，以便在 content_block_stop 时可用（如果需要）
              const existing = aggregatedThinking.get(idx) || '';
              aggregatedThinking.set(idx, existing + thinkingChunk);
            }
          } else if (chunk.type === 'content_block_stop') {
            const tool = aggregatedTools.get(idx);
            if (tool) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: tool.name, args: parseJSONSafe(tool.args), id: tool.id } }] };
              const resp = {
                candidates: [{
                  content,
                  index: 0
                }]
              };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as GenerateContentResponse;
              aggregatedTools.delete(idx);
            }
            // 🆕 thinking 内容已在 thinking_delta 中实时流式输出，这里只需清理状态
            // 不再重复 yield 完整内容，避免 UI 显示重复
            if (aggregatedThinking.has(idx)) {
              aggregatedThinking.delete(idx);
            }
          } else if (chunk.type === 'message_delta') {
            // 🔧 message_delta 中的 output_tokens 是最终总数，不是增量，所以用替换而非累加
            // 参考日志：message_start 有 output_tokens:5，message_delta 有 output_tokens:298（最终值）
            if (chunk.usage?.output_tokens != null) {
              totalOutputTokens = chunk.usage.output_tokens;
            }

            // 🔧 鲁棒性增强：一些上游厂商（如 GLM-4 的 Anthropic 兼容接口）在 message_start 中
            // 返回 input_tokens: 0，但在最后的 message_delta 中才返回真实的 token 用量。
            // 这里采用"有非零值就更新"的策略，确保能从任何位置获取正确的 token 数据。
            if (chunk.usage?.input_tokens != null && chunk.usage.input_tokens > 0) {
              inputTokens = chunk.usage.input_tokens;
            }
            if (chunk.usage?.cache_creation_input_tokens != null && chunk.usage.cache_creation_input_tokens > 0) {
              cacheCreationInputTokens = chunk.usage.cache_creation_input_tokens;
            }
            if (chunk.usage?.cache_read_input_tokens != null && chunk.usage.cache_read_input_tokens > 0) {
              cacheReadInputTokens = chunk.usage.cache_read_input_tokens;
            }

            // 🔧 计算真正的总输入 token：
            // Anthropic 的 input_tokens 只是非缓存的直接输入，实际总输入需要加上缓存 token
            // 实际总输入 = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
            const actualPromptTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;

            const content = { role: MESSAGE_ROLES.MODEL, parts: [] };
            const resp = {
              candidates: [{
                content,
                finishReason: AnthropicConverter.mapFinishReason(chunk.delta?.stop_reason),
                index: 0
              }],
              usageMetadata: {
                // promptTokenCount 应该反映实际处理的总输入 token（包括缓存）
                promptTokenCount: actualPromptTokens,
                candidatesTokenCount: totalOutputTokens,
                totalTokenCount: actualPromptTokens + totalOutputTokens,
                // 🔧 Claude prompt caching 详细信息
                // 字段名与 geminiChat.ts 中读取的一致（不带 Count 后缀）
                // - cacheCreationInputTokens: 本次写入缓存的 token（1.25x 价格）
                // - cacheReadInputTokens: 从缓存读取的 token（0.1x 价格，便宜 90%）
                // - uncachedInputTokens: 非缓存的直接输入 token（原始 input_tokens）
                ...(cacheCreationInputTokens != null && { cacheCreationInputTokens }),
                ...(cacheReadInputTokens != null && { cacheReadInputTokens }),
                // 保留原始的非缓存输入 token 以便精确计费
                uncachedInputTokens: inputTokens,
              }
            } as any;
            addFunctionCallsGetter(resp);
            addFunctionCallsGetter(content);
            yield resp;
          } else if (chunk.type === 'message_start' && chunk.message?.usage) {
            // 🔧 message_start 包含完整的初始 usage，包括缓存 token
            const usage = chunk.message.usage;
            inputTokens = usage.input_tokens || 0;
            totalOutputTokens = usage.output_tokens || 0;
            // 缓存 token 只在 message_start 中出现，记录后不再累加
            cacheCreationInputTokens = usage.cache_creation_input_tokens || 0;
            cacheReadInputTokens = usage.cache_read_input_tokens || 0;
          }
        } catch (e) {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 统一入口
 */
export async function* callCustomModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): AsyncGenerator<GenerateContentResponse> {
  console.log(`[CustomModel] Stream call: ${modelConfig.displayName} (${modelConfig.provider})`);
  if (modelConfig.provider === 'openai') yield* callOpenAICompatibleModelStream(modelConfig, request, abortSignal);
  else if (modelConfig.provider === 'openai-responses') yield* callOpenAIResponsesModelStream(modelConfig, request, abortSignal);
  else if (modelConfig.provider === 'anthropic') yield* callAnthropicModelStream(modelConfig, request, abortSignal);
  else throw new Error(`Unsupported custom model provider for streaming: ${modelConfig.provider}`);
}

export async function callCustomModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): Promise<GenerateContentResponse> {
  console.log(`[CustomModel] Unary call: ${modelConfig.displayName} (${modelConfig.provider})`);
  if (modelConfig.provider === 'openai') return callOpenAICompatibleModel(modelConfig, request, abortSignal);
  else if (modelConfig.provider === 'openai-responses') return callOpenAIResponsesModel(modelConfig, request, abortSignal);
  else if (modelConfig.provider === 'anthropic') return callAnthropicModel(modelConfig, request, abortSignal);
  else throw new Error(`Unsupported custom model provider: ${modelConfig.provider}`);
}

/**
 * @internal
 * 导出 parseJSONSafe 用于单元测试
 * 这是内部实现细节，不属于公开 API，可能随时变更
 */
export { parseJSONSafe as parseJSONSafeExport };
