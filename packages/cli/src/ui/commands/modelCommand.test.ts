/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelCommand } from './modelCommand.js';
import { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('modelCommand', () => {
  let mockContext: CommandContext;
  let mockConfig: any;
  let mockSettings: any;
  let mockGeminiClient: any;

  beforeEach(() => {
    mockGeminiClient = {
      getChat: vi.fn().mockReturnValue({ setSpecifiedModel: vi.fn() }),
      switchModel: vi.fn().mockResolvedValue({ success: true }),
    };

    mockConfig = {
      setModel: vi.fn(),
      resetModelToDefault: vi.fn(),
      getModel: vi.fn().mockReturnValue('default-model'),
      getGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
      getCloudModels: vi.fn().mockReturnValue([]),
      setCloudModels: vi.fn(),
    };

    mockSettings = {
      merged: {
        preferredModel: undefined,
      },
      setValue: vi.fn(),
    };

    mockContext = createMockCommandContext();
    mockContext.services.config = mockConfig;
    mockContext.services.settings = mockSettings;
  });

  it('should return a dialog action when no args provided', () => {
    const result = modelCommand.action!(mockContext, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
    });
  });

  it('should return void when args provided (handles it asynchronously)', async () => {
    const result = modelCommand.action!(mockContext, 'claude-3-sonnet');
    expect(result).toBeUndefined();
  });

  it('should not have completion function (removed to allow direct command execution)', () => {
    // completion 函数已移除，用户输入 /model 后直接回车打开选择器
    expect(modelCommand.completion).toBeUndefined();
  });

  // ============================================================================
  // /model favorites 子命令测试
  // ============================================================================

  describe('/model favorites', () => {
    it('favorites list should show "no favorites" when empty', () => {
      mockSettings.merged.favoriteModels = [];
      modelCommand.action!(mockContext, 'favorites list');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('当前没有收藏模型') }),
        expect.any(Number),
      );
    });

    it('favorites list should show favorites when non-empty', () => {
      mockSettings.merged.favoriteModels = ['glm-5.1', 'deepseek-v4-flash'];
      modelCommand.action!(mockContext, 'favorites list');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('GLM-5.1') }),
        expect.any(Number),
      );
    });

    it('favorites add should error without model name', () => {
      mockSettings.merged.favoriteModels = [];
      modelCommand.action!(mockContext, 'favorites add');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('请指定模型名称') }),
        expect.any(Number),
      );
    });

    it('favorites remove should error without model name', () => {
      mockSettings.merged.favoriteModels = ['glm-5.1'];
      modelCommand.action!(mockContext, 'favorites remove');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('请指定要移除的模型') }),
        expect.any(Number),
      );
    });

    it('favorites remove should error when model not found', () => {
      mockSettings.merged.favoriteModels = ['glm-5.1'];
      modelCommand.action!(mockContext, 'favorites remove deepseek-v4-pro');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('不在收藏列表中') }),
        expect.any(Number),
      );
    });

    it('favorites with unknown subcommand should show usage', () => {
      modelCommand.action!(mockContext, 'favorites unknown');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('未知子命令') }),
        expect.any(Number),
      );
    });

    it('favorites (no subcommand) should default to list', () => {
      mockSettings.merged.favoriteModels = [];
      modelCommand.action!(mockContext, 'favorites');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('当前没有收藏模型') }),
        expect.any(Number),
      );
    });
  });
});