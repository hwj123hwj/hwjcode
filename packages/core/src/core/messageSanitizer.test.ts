/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import {
  cleanContents,
  dedupeToolUseIds,
  enforceToolPairConsistency,
  sanitizeConversation
} from './messageSanitizer.js';

describe('messageSanitizer - cleanContents', () => {
  it('should remove empty or white-spaced text parts', () => {
    const input = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: ' ' }, { text: 'Hello' }, { text: '' }]
      }
    ];
    const result = cleanContents(input);
    expect(result).toHaveLength(1);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0]).toEqual({ text: 'Hello' });
  });

  it('should consolidate consecutive model messages and merge thinking', () => {
    const input = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: 'Question' }]
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ reasoning: 'I am thinking...' }]
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: 'Answer' }]
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: 'Next question' }]
      }
    ];
    const result = cleanContents(input);
    // 应合并纯思维消息到后一个含有实质内容的模型消息中
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe(MESSAGE_ROLES.USER);
    expect(result[1].role).toBe(MESSAGE_ROLES.MODEL);
    expect(result[1].parts).toHaveLength(2);
    expect(result[1].parts[0]).toEqual({ reasoning: 'I am thinking...' });
    expect(result[1].parts[1]).toEqual({ text: 'Answer' });
    expect(result[2].role).toBe(MESSAGE_ROLES.USER);
  });

  it('should ensure the conversation ends with a user placeholder if last message is model', () => {
    const input = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: 'Question' }]
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: 'Answer' }]
      }
    ];
    const result = cleanContents(input);
    expect(result).toHaveLength(3);
    expect(result[result.length - 1].role).toBe(MESSAGE_ROLES.USER);
    expect(result[result.length - 1].parts[0].text).toBe('[Conversation continues]');
  });
});

describe('messageSanitizer - dedupeToolUseIds', () => {
  it('should deduplicate repeating functionCall IDs and remap corresponding functionResponse IDs', () => {
    const input = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: 'Call 1' }]
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'tool1', args: {}, id: 'call_1' } }]
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'tool1', response: 'res1', id: 'call_1' } }]
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'tool1', args: {}, id: 'call_1' } }] // 重复的 ID
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'tool1', response: 'res2', id: 'call_1' } }] // 对应的重复 Response ID
      }
    ];

    const result = dedupeToolUseIds(input);
    expect(result[1].parts[0].functionCall.id).toBe('call_1');
    expect(result[2].parts[0].functionResponse.id).toBe('call_1');

    // 第二个重复的 ID 应当被改写
    expect(result[3].parts[0].functionCall.id).toBe('call_1_dup_1');
    expect(result[4].parts[0].functionResponse.id).toBe('call_1_dup_1');
  });
});

describe('messageSanitizer - enforceToolPairConsistency', () => {
  it('should synthesize missing tool results in "synthesize" mode', () => {
    const input = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: 'Search' }]
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'web_search', args: { query: 'abc' }, id: 'call_s' } }]
      }
      // 没有紧随其后的 user functionResponse
    ];

    const result = enforceToolPairConsistency(input, 'synthesize');
    expect(result).toHaveLength(3);
    expect(result[2].role).toBe(MESSAGE_ROLES.USER);
    expect(result[2].parts[0].functionResponse).toEqual({
      name: 'web_search',
      id: 'call_s',
      response: { error: '[no response]' }
    });
  });

  it('should drop unmatched tool calls in "drop" mode', () => {
    const input = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: 'Search' }]
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { text: 'Look at this:' },
          { functionCall: { name: 'web_search', args: { query: 'abc' }, id: 'call_s' } }
        ]
      }
    ];

    const result = enforceToolPairConsistency(input, 'drop');
    expect(result).toHaveLength(2);
    expect(result[1].parts).toHaveLength(1);
    expect(result[1].parts[0]).toEqual({ text: 'Look at this:' });
  });

  it('should drop orphan function responses that have no matching functionCall', () => {
    const input = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'web_search', id: 'orphan_id', response: {} } }]
      }
    ];

    const result = enforceToolPairConsistency(input, 'synthesize');
    // 因为唯一的 parts 是孤立的 functionResponse，所以整条消息会被过滤掉
    expect(result).toHaveLength(0);
  });

  it('should drop tool results whose corresponding tool use is not in the PREVIOUS model message', () => {
    const input = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'web_search', id: 'call_1', args: {} } }]
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'web_search', id: 'call_1', response: {} } }]
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: 'Here is what I found' }]
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'web_search', id: 'call_1', response: {} } }]
      }
    ];

    const result = enforceToolPairConsistency(input, 'synthesize');
    // 最后一个 user 消息由于前置模型消息不含该 functionCall 应该被自动过滤丢弃
    expect(result).toHaveLength(3);
  });
});

describe('messageSanitizer - sanitizeConversation', () => {
  it('should perform end-to-end sanitization', () => {
    const input = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: 'Search' }]
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'web_search', args: { query: 'abc' }, id: 'call_s' } }]
      }
    ];

    const result = sanitizeConversation(input);
    // 应在尾部自动补充未应答的 functionResponse
    expect(result).toHaveLength(3);
    expect(result[2].role).toBe(MESSAGE_ROLES.USER);
    expect(result[2].parts[0].functionResponse.id).toBe('call_s');
  });
});
