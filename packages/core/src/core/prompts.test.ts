/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getCoreSystemPrompt, isGemini3Model } from './prompts.js';

describe('prompts', () => {
  describe('isGemini3Model', () => {
    it('should identify gemini-3 models correctly', () => {
      expect(isGemini3Model('gemini-3-flash-preview')).toBe(true);
      expect(isGemini3Model('gemini3-pro')).toBe(true);
      expect(isGemini3Model('gemini-2.0-flash')).toBe(false);
      expect(isGemini3Model(undefined)).toBe(false);
    });
  });

  describe('getCoreSystemPrompt - Environment Differences', () => {
    it('should include VSCode-specific instructions when isVSCode is true', () => {
      const prompt = getCoreSystemPrompt(undefined, true);
      expect(prompt).toContain('interactive VSCode assistant');
      // 验证是否包含 lint 检查的描述
      expect(prompt).toContain('read_lints');
    });

    it('should use CLI instructions when isVSCode is false', () => {
      const prompt = getCoreSystemPrompt(undefined, false);
      expect(prompt).toContain('interactive CLI tool');
    });
  });

  describe('getCoreSystemPrompt - Model Differences', () => {
    it('should use Gemini 3 specific instructions for Gemini 3 models', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'default', 'gemini-3-flash');
      expect(prompt).toContain('strictly grounded to the information provided in context');
      expect(prompt).toContain('Context is Truth');
    });

    it('should use standard instructions for other models', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'default', 'gemini-1.5-pro');
      expect(prompt).not.toContain('Context is Truth');
    });
  });

  describe('getCoreSystemPrompt - Agent Style Differences', () => {
    it('should use Codex style prompt when requested', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'codex');
      expect(prompt).toContain('CODEX MODE');
      expect(prompt).toContain('NO NARRATION');
    });

    it('should use Cursor style prompt when requested', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'cursor');
      expect(prompt).toContain('CURSOR MODE');
      expect(prompt).toContain('STATUS UPDATES');
    });

    it('should use Windsurf style prompt when requested', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'windsurf');
      expect(prompt).toContain('WINDSURF MODE');
      expect(prompt).toContain('AI Flow');
    });
  });

  describe('getCoreSystemPrompt - Language Preference', () => {
    it('should append language preference at the end', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'default', undefined, '简体中文');
      // 检查加粗格式
      expect(prompt).toContain('**Language Preference:** Please always use "简体中文" to reply to the user.');
    });
  });

  describe('getCoreSystemPrompt - Custom Model Info', () => {
    it('should include custom model server info', () => {
      const customModel = {
        provider: 'openai',
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1'
      };
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'default', undefined, undefined, customModel);
      // 检查 Markdown 行内代码格式
      expect(prompt).toContain('**Current Model:** `gpt-4o`');
      expect(prompt).toContain('served by user-configured endpoint `https://api.openai.com/v1`');
    });
  });

  describe('getCoreSystemPrompt - Skills Context Injection', () => {
    afterEach(async () => {
      // 恢复原始函数
      const skillsIntegration = await import('../skills/skills-integration.js');
      vi.mocked(skillsIntegration.getSkillsContext).mockRestore?.();
    });

    it('should include skills context when available', async () => {
      // Mock getSkillsContext to return sample skills
      const mockSkillsContext = `# Available Skills

<available_skills>
<skill>
<name>test-skill</name>
<description>A test skill for validation 📜</description>
</skill>
</available_skills>`;

      const skillsIntegration = await import('../skills/skills-integration.js');
      vi.spyOn(skillsIntegration, 'getSkillsContext').mockReturnValue(mockSkillsContext);

      const prompt = getCoreSystemPrompt(undefined, false);

      expect(prompt).toContain('# Available Skills');
      expect(prompt).toContain('<available_skills>');
      expect(prompt).toContain('test-skill');
    });

    it('should not add extra content when skills context is empty', async () => {
      const skillsIntegration = await import('../skills/skills-integration.js');
      vi.spyOn(skillsIntegration, 'getSkillsContext').mockReturnValue('');

      const prompt = getCoreSystemPrompt(undefined, false);

      // 不应该包含空的 Skills section
      expect(prompt).not.toContain('# Available Skills');
    });
  });
});
