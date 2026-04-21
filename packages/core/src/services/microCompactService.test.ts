/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Content } from '../types/extendedContent.js';
import {
  MicroCompactService,
  COMPACTABLE_TOOLS,
  CLEARED_TOOL_RESULT_MARKER,
} from './microCompactService.js';

describe('MicroCompactService', () => {
  let service: MicroCompactService;

  beforeEach(() => {
    service = new MicroCompactService({
      idleThresholdMinutes: 60,
      keepRecentToolResults: 2,
      enabled: true,
    });
  });

  describe('shouldMicroCompact', () => {
    it('should not trigger when recently active', () => {
      service.updateLastAssistantMessageTime();
      expect(service.shouldMicroCompact()).toBe(false);
    });

    it('should not trigger when disabled', () => {
      service.setEnabled(false);
      expect(service.shouldMicroCompact()).toBe(false);
    });
  });

  describe('microCompactMessages', () => {
    const createHistoryWithToolResults = (): Content[] => [
      // env messages (skip 2)
      { role: 'user', parts: [{ text: 'Environment' }] },
      { role: 'model', parts: [{ text: 'Got it!' }] },
      // tool call 1
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: '/a.txt' }, id: 'call_1' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'File content A (very long)' }, id: 'call_1' } } as any] },
      // tool call 2
      { role: 'model', parts: [{ functionCall: { name: 'search_file_content', args: { pattern: 'foo' }, id: 'call_2' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'search_file_content', response: { output: 'Search results...' }, id: 'call_2' } } as any] },
      // tool call 3 (non-compactable)
      { role: 'model', parts: [{ functionCall: { name: 'save_memory', args: { fact: 'test' }, id: 'call_3' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'save_memory', response: { output: 'Saved' }, id: 'call_3' } } as any] },
      // tool call 4
      { role: 'model', parts: [{ functionCall: { name: 'glob', args: { pattern: '*.ts' }, id: 'call_4' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'glob', response: { output: 'file1.ts\nfile2.ts' }, id: 'call_4' } } as any] },
      // tool call 5
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: '/b.txt' }, id: 'call_5' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'File content B' }, id: 'call_5' } } as any] },
    ];

    it('should not clear when not idle enough', () => {
      const history = createHistoryWithToolResults();
      service.updateLastAssistantMessageTime(); // just active
      const result = service.microCompactMessages(history, 2);

      expect(result.applied).toBe(false);
      expect(result.clearedCount).toBe(0);
    });

    it('should clear old compactable tool results when idle', () => {
      const history = createHistoryWithToolResults();

      // 模拟超过空闲阈值：直接修改内部状态
      (service as any).lastAssistantMessageTime = Date.now() - (61 * 60 * 1000); // 61 minutes ago

      const result = service.microCompactMessages(history, 2);

      expect(result.applied).toBe(true);
      // 4 compactable tool results (read_file x2, search_file_content, glob), keepRecent=2
      // So 2 should be cleared (the oldest 2)
      expect(result.clearedCount).toBe(2);

      // First compactable result should be cleared
      const firstToolResponse = (history[3].parts![0] as any).functionResponse;
      expect(firstToolResponse.response.output).toBe(CLEARED_TOOL_RESULT_MARKER);

      // save_memory is non-compactable, should NOT be cleared
      const nonCompactableResponse = (history[7].parts![0] as any).functionResponse;
      expect(nonCompactableResponse.response.output).toBe('Saved');

      // Last compactable result should be kept
      const lastToolResponse = (history[11].parts![0] as any).functionResponse;
      expect(lastToolResponse.response.output).toBe('File content B');
    });

    it('should not clear already-cleared results', () => {
      const history = createHistoryWithToolResults();

      // Pre-clear the first one
      (history[3].parts![0] as any).functionResponse.response = { output: CLEARED_TOOL_RESULT_MARKER };

      (service as any).lastAssistantMessageTime = Date.now() - (61 * 60 * 1000);
      const result = service.microCompactMessages(history, 2);

      // Only 3 non-cleared compactable results, keepRecent=2, so only 1 more cleared
      expect(result.clearedCount).toBe(1);
    });

    it('should skip environment messages', () => {
      // Put a tool result in env messages
      const history: Content[] = [
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'env file' }, id: 'env_1' } } as any] },
        { role: 'model', parts: [{ text: 'Got it!' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: '/x.txt' }, id: 'call_x' } } as any] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'X content' }, id: 'call_x' } } as any] },
      ];

      (service as any).lastAssistantMessageTime = Date.now() - (61 * 60 * 1000);
      service.microCompactMessages(history, 2);

      // Env message should not be touched
      const envResponse = (history[0].parts![0] as any).functionResponse;
      expect(envResponse.response.output).toBe('env file');
    });

    it('should return disabled reason when disabled', () => {
      service.setEnabled(false);
      const result = service.microCompactMessages([], 2);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('disabled');
    });
  });

  describe('reset', () => {
    it('should reset lastAssistantMessageTime', () => {
      (service as any).lastAssistantMessageTime = 0;
      expect(service.getIdleMinutes()).toBeGreaterThan(0);
      service.reset();
      expect(service.getIdleMinutes()).toBeLessThan(1);
    });
  });

  describe('COMPACTABLE_TOOLS', () => {
    it('should include common high-frequency tools', () => {
      expect(COMPACTABLE_TOOLS.has('read_file')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('run_shell_command')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('search_file_content')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('glob')).toBe(true);
    });

    it('should not include state-changing tools', () => {
      expect(COMPACTABLE_TOOLS.has('save_memory')).toBe(false);
      expect(COMPACTABLE_TOOLS.has('todo_write')).toBe(false);
      expect(COMPACTABLE_TOOLS.has('use_skill')).toBe(false);
    });
  });

  describe('getConfig', () => {
    it('should return current configuration', () => {
      const config = service.getConfig();
      expect(config.idleThresholdMinutes).toBe(60);
      expect(config.keepRecentToolResults).toBe(2);
      expect(config.enabled).toBe(true);
    });
  });
});
