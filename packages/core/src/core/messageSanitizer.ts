/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { MESSAGE_ROLES } from '../config/messageRoles.js';

/**
 * 基础消息清理与重整
 * 分离思维部分、合并连续 model 消息，并过滤空文本块和确保以 user 消息结尾。
 */
export function cleanContents(contents: any[]): any[] {
  if (!Array.isArray(contents)) return contents;

  const consolidated: any[] = [];
  let accumulatedReasoning: any[] = [];

  for (const content of contents) {
    // 深度拷贝消息，同时过滤掉无效的空文本/空白字符块
    const clonedParts = content.parts
      ? content.parts.filter((p: any) => {
          if (p && p.text !== undefined) {
            return typeof p.text === 'string' && p.text.trim() !== '';
          }
          return p !== null && p !== undefined;
        })
      : [];

    const clonedContent = {
      role: content.role,
      parts: clonedParts,
      prompt_id: content.prompt_id
    };

    if (clonedContent.role === MESSAGE_ROLES.MODEL) {
      const parts = clonedContent.parts || [];

      // 分离思维部分与非思维部分
      const reasoningParts = parts.filter((p: any) => p && p.reasoning !== undefined);
      const nonReasoningParts = parts.filter((p: any) => p && p.reasoning === undefined);

      if (reasoningParts.length > 0) {
        accumulatedReasoning.push(...reasoningParts);
      }

      if (nonReasoningParts.length > 0) {
        if (accumulatedReasoning.length > 0) {
          clonedContent.parts = [...accumulatedReasoning, ...nonReasoningParts];
          accumulatedReasoning = []; // 消费后清除暂存
        } else {
          clonedContent.parts = nonReasoningParts;
        }

        // 合并同一回合内连续的 model 消息
        const lastConsolidated = consolidated[consolidated.length - 1];
        if (lastConsolidated && lastConsolidated.role === MESSAGE_ROLES.MODEL) {
          lastConsolidated.parts.push(...clonedContent.parts);
        } else {
          consolidated.push(clonedContent);
        }
      } else {
        // 如果是纯思维链消息且已经累积，安全跳过
        continue;
      }
    } else {
      accumulatedReasoning = [];
      consolidated.push(clonedContent);
    }
  }

  const cleaned = consolidated.filter(content => {
    if (!content.parts || content.parts.length === 0) return false;
    const hasValidPart = content.parts.some((part: any) => {
      if (part.text !== undefined) return part.text.trim() !== '';
      return true;
    });
    return hasValidPart;
  });

  // 安全保障：确保清洗后 contents 不以 model/assistant 结尾
  if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === MESSAGE_ROLES.MODEL) {
    console.warn('[cleanContents] Contents ends with model message after cleanup — appending user placeholder');
    cleaned.push({
      role: MESSAGE_ROLES.USER,
      parts: [{ text: '[Conversation continues]' }],
    });
  }

  return cleaned;
}

/**
 * 全局去重 functionCall 产生的唯一 ID（解决 Bedrock/Anthropic 等由于 id 重复引发的 400 报错）
 */
export function dedupeToolUseIds(contents: any[]): any[] {
  const seenIds = new Set<string>();
  const renamedQueues = new Map<string, string[]>();
  const remappedConsumers = new Map<string, number>();
  let renameCounter = 0;

  // 1. 先扫一遍 functionCall (model 角色)，决定哪些要改名
  for (const msg of contents) {
    if (msg.role !== MESSAGE_ROLES.MODEL) continue;
    if (!msg.parts) continue;
    for (const p of msg.parts) {
      if (!p.functionCall || !p.functionCall.id) continue;
      const oldId = p.functionCall.id;
      if (!seenIds.has(oldId)) {
        seenIds.add(oldId);
        continue;
      }
      // 重复 -> 生成新 id
      const newId = `${oldId}_dup_${++renameCounter}`;
      p.functionCall.id = newId;
      seenIds.add(newId);

      const q = renamedQueues.get(oldId) || [];
      q.push(newId);
      renamedQueues.set(oldId, q);
    }
  }

  if (renamedQueues.size === 0) return contents;

  // 2. 再扫一遍 functionResponse (user 角色) 进行一致性映射
  const seenResultCount = new Map<string, number>();
  for (const msg of contents) {
    if (msg.role !== MESSAGE_ROLES.USER) continue;
    if (!msg.parts) continue;
    for (const p of msg.parts) {
      if (!p.functionResponse || !p.functionResponse.id) continue;
      const origId = p.functionResponse.id;
      const queue = renamedQueues.get(origId);
      if (!queue) continue;
      const occur = seenResultCount.get(origId) || 0;
      seenResultCount.set(origId, occur + 1);
      if (occur === 0) {
        continue; // 第一次出现，保持原 id，配对首次 functionCall
      }
      const idx = occur - 1;
      const consumed = remappedConsumers.get(origId) || 0;
      const targetNewId = queue[idx] ?? queue[queue.length - 1];
      p.functionResponse.id = targetNewId;
      remappedConsumers.set(origId, consumed + 1);
    }
  }

  return contents;
}

/**
 * 强制保证 functionCall 和 functionResponse 之间的配对一致性
 * 解决 Gemini 类似 "number of function response parts is equal to the number of function call parts" 错误
 */
export function enforceToolPairConsistency(
  contents: any[],
  unmatchedToolUseMode: 'synthesize' | 'drop' = 'synthesize'
): any[] {
  const allFunctionCallIds = new Set<string>();
  for (const msg of contents) {
    if (msg.role !== MESSAGE_ROLES.MODEL) continue;
    if (!msg.parts) continue;
    for (const p of msg.parts) {
      if (p.functionCall && p.functionCall.id) {
        allFunctionCallIds.add(p.functionCall.id);
      }
    }
  }

  const out: any[] = [];

  for (let i = 0; i < contents.length; i++) {
    const msg = contents[i];

    if (msg.role === MESSAGE_ROLES.MODEL) {
      // 找下一条 user 消息
      const nextUserIdx = findNextUserIndex(contents, i + 1);
      const nextUser = nextUserIdx >= 0 ? contents[nextUserIdx] : null;

      const functionCalls = (msg.parts || []).filter(
        (p: any) => p.functionCall && p.functionCall.id
      );

      if (functionCalls.length === 0) {
        out.push(msg);
        continue;
      }

      const respondedIds = new Set<string>();
      if (nextUser && nextUser.parts) {
        for (const p of nextUser.parts) {
          if (p.functionResponse && p.functionResponse.id) {
            respondedIds.add(p.functionResponse.id);
          }
        }
      }

      const unanswered = functionCalls.filter(
        (p: any) => !respondedIds.has(p.functionCall.id)
      );

      if (unanswered.length === 0) {
        out.push(msg);
        continue;
      }

      if (unmatchedToolUseMode === 'drop') {
        const unansweredIdSet = new Set(unanswered.map((p: any) => p.functionCall.id));
        const newParts = msg.parts.filter(
          (p: any) => !(p.functionCall && p.functionCall.id && unansweredIdSet.has(p.functionCall.id))
        );
        if (newParts.length > 0) {
          out.push({ ...msg, parts: newParts });
        }
        continue;
      }

      // synthesize: 补上占位 functionResponse
      out.push(msg);

      const synthParts = unanswered.map((p: any) => ({
        functionResponse: {
          name: p.functionCall.name,
          id: p.functionCall.id,
          response: { error: '[no response]' }
        }
      }));

      if (nextUser) {
        nextUser.parts = [...synthParts, ...nextUser.parts];
      } else {
        out.push({ role: MESSAGE_ROLES.USER, parts: synthParts });
      }
      continue;
    }

    if (msg.role === MESSAGE_ROLES.USER) {
      if (!msg.parts) continue;

      const prevMsg = i > 0 ? contents[i - 1] : null;
      const prevCallIds = new Set<string>();
      if (prevMsg && prevMsg.role === MESSAGE_ROLES.MODEL && prevMsg.parts) {
        for (const p of prevMsg.parts) {
          if (p.functionCall && p.functionCall.id) {
            prevCallIds.add(p.functionCall.id);
          }
        }
      }

      const filteredParts = msg.parts.filter((p: any) => {
        if (p.functionResponse && p.functionResponse.id) {
          if (!prevCallIds.has(p.functionResponse.id)) {
            return false; // 丢弃在前一个 model 消息中找不到配对的 functionResponse
          }
        }
        return true;
      });
      if (filteredParts.length === 0) {
        continue; // 丢弃变为空消息的 user 内容
      }
      out.push({ ...msg, parts: filteredParts });
      continue;
    }

    out.push(msg);
  }

  return out;
}

function findNextUserIndex(contents: any[], start: number): number {
  if (start >= contents.length) return -1;
  return contents[start].role === MESSAGE_ROLES.USER ? start : -1;
}

/**
 * 对话历史整体清洗和修复的总编排函数
 */
export function sanitizeConversation(
  contents: any[],
  options: { unmatchedToolUseMode?: 'synthesize' | 'drop'; provider?: string } = {}
): any[] {
  if (!Array.isArray(contents)) return contents;

  // 深度克隆 contents 及其 parts，避免污染传入的原始数组和对象
  let working = contents.map((m) => {
    const partsCopy = Array.isArray(m.parts)
      ? m.parts.map((p: any) => {
          const pCopy = { ...p };
          if (p.functionCall) pCopy.functionCall = { ...p.functionCall };
          if (p.functionResponse) pCopy.functionResponse = { ...p.functionResponse };
          return pCopy;
        })
      : [];
    return {
      role: m.role,
      parts: partsCopy,
      prompt_id: m.prompt_id
    };
  });

  // Pass 1: tool_use.id 全局去重
  working = dedupeToolUseIds(working);

  // Pass 2: 强制 tool 一致性对齐
  working = enforceToolPairConsistency(
    working,
    options.unmatchedToolUseMode ?? 'synthesize'
  );

  return working;
}
