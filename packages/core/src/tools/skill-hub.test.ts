import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkillHubTool } from './skill-hub.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock fetchWithTimeout
vi.mock('../utils/fetch.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../utils/fetch.js';

const mockFetch = fetchWithTimeout as unknown as ReturnType<typeof vi.fn>;

describe('SkillHubTool', () => {
  let tool: SkillHubTool;
  let mockConfig: any;
  let tempProjectDir: string;

  beforeEach(() => {
    tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hub-test-'));

    mockConfig = {
      getProjectRoot: vi.fn().mockReturnValue(tempProjectDir),
    };

    tool = new SkillHubTool(mockConfig as any);
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempProjectDir, { recursive: true, force: true });
  });

  describe('install path', () => {
    it('should install skill to project-level .easycode/skills/ directory', async () => {
      // Mock SKILL.md download
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('SKILL.md')) {
          return Promise.resolve({ ok: true, text: () => Promise.resolve('# Test Skill\nTest content') });
        }
        // Git tree API fallback
        return Promise.resolve({ ok: false });
      });

      const result = await tool.execute(
        { action: 'install', skillId: 'test-skill' },
        new AbortController().signal,
      );

      // Verify installed to project-level path, NOT global ~/.easycode-user/skills/
      const projectSkillsDir = path.join(tempProjectDir, '.easycode', 'skills', 'test-skill');
      const skillMdPath = path.join(projectSkillsDir, 'SKILL.md');

      expect(fs.existsSync(skillMdPath)).toBe(true);
      expect(fs.readFileSync(skillMdPath, 'utf-8')).toBe('# Test Skill\nTest content');
      expect(result.llmContent).toContain(skillMdPath);
      expect(result.llmContent).not.toContain('.easycode-user');
    });

    it('should detect already-installed skill in project directory', async () => {
      const projectSkillsDir = path.join(tempProjectDir, '.easycode', 'skills', 'existing-skill');
      fs.mkdirSync(projectSkillsDir, { recursive: true });
      fs.writeFileSync(path.join(projectSkillsDir, 'SKILL.md'), '# Existing', 'utf-8');

      const result = await tool.execute(
        { action: 'install', skillId: 'existing-skill' },
        new AbortController().signal,
      );

      expect(result.returnDisplay).toContain('already installed');
      expect(result.llmContent).toContain('.easycode/skills/existing-skill');
      expect(result.llmContent).not.toContain('.easycode-user');
    });
  });

  describe('toolLocations', () => {
    it('should return project-level path for install action', () => {
      const locations = tool.toolLocations({ action: 'install', skillId: 'my-skill' });
      expect(locations).toHaveLength(1);
      expect(locations[0].path).toContain('.easycode/skills/my-skill/SKILL.md');
      expect(locations[0].path).toContain(tempProjectDir);
      expect(locations[0].path).not.toContain('.easycode-user');
    });

    it('should return empty array for non-install actions', () => {
      expect(tool.toolLocations({ action: 'search', query: 'test' })).toEqual([]);
      expect(tool.toolLocations({ action: 'list' })).toEqual([]);
    });
  });

  describe('shouldConfirmExecute', () => {
    it('should mention project directory in install confirmation prompt', async () => {
      const confirm = await tool.shouldConfirmExecute({ action: 'install', skillId: 'my-skill' });
      expect(confirm).not.toBe(false);
      expect((confirm as any).prompt).toContain('.easycode/skills/my-skill');
      expect((confirm as any).prompt).not.toContain('.easycode-user');
    });

    it('should not require confirmation for search and list', async () => {
      expect(await tool.shouldConfirmExecute({ action: 'search', query: 'test' })).toBe(false);
      expect(await tool.shouldConfirmExecute({ action: 'list' })).toBe(false);
    });
  });
});
