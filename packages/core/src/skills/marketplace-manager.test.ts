/**
 * MarketplaceManager Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { MarketplaceManager } from './marketplace-manager.js';
import { SettingsManager, SkillsPaths } from './settings-manager.js';
import { MarketplaceSource, SkillErrorCode } from './skill-types.js';

describe('MarketplaceManager', () => {
  let manager: MarketplaceManager;
  let settingsManager: SettingsManager;
  let testRoot: string;
  let testMarketplacePath: string;

  beforeEach(async () => {
    // 创建临时测试目录
    testRoot = path.join(os.tmpdir(), `deepv-test-mp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testMarketplacePath = path.join(testRoot, 'test-marketplace');

    // Mock SkillsPaths
    vi.spyOn(SkillsPaths, 'DEEPV_HOME', 'get').mockReturnValue(testRoot);
    vi.spyOn(SkillsPaths, 'SKILLS_ROOT', 'get').mockReturnValue(path.join(testRoot, 'skills'));
    vi.spyOn(SkillsPaths, 'MARKETPLACE_ROOT', 'get').mockReturnValue(
      path.join(testRoot, 'marketplace'),
    );
    vi.spyOn(SkillsPaths, 'SETTINGS_FILE', 'get').mockReturnValue(
      path.join(testRoot, 'skills', 'settings.json'),
    );
    vi.spyOn(SkillsPaths, 'INSTALLED_PLUGINS_FILE', 'get').mockReturnValue(
      path.join(testRoot, 'skills', 'installed_plugins.json'),
    );
    vi.spyOn(SkillsPaths, 'BACKUP_DIR', 'get').mockReturnValue(
      path.join(testRoot, 'skills', 'backups'),
    );
    vi.spyOn(SkillsPaths, 'PLUGIN_CACHE_ROOT', 'get').mockReturnValue(
      path.join(testRoot, 'skills', 'cache'),
    );

    settingsManager = new SettingsManager();
    await settingsManager.initialize();

    manager = new MarketplaceManager(settingsManager);
  });

  afterEach(async () => {
    // 清理测试目录
    await fs.remove(testRoot);
    vi.restoreAllMocks();
  });

  /**
   * 创建测试用的 Marketplace 结构
   */
  async function createTestMarketplace(marketplacePath: string) {
    // 创建目录结构
    await fs.ensureDir(marketplacePath);
    await fs.ensureDir(path.join(marketplacePath, '.claude-plugin'));
    await fs.ensureDir(path.join(marketplacePath, 'test-plugin'));
    await fs.ensureDir(path.join(marketplacePath, 'test-plugin', 'skill1'));
    await fs.ensureDir(path.join(marketplacePath, 'test-plugin', 'skill2'));

    // 创建 marketplace.json
    const marketplaceJson = {
      name: 'test-marketplace',
      owner: {
        name: 'Test Owner',
        email: 'test@example.com',
      },
      metadata: {
        description: 'Test Marketplace',
        version: '1.0.0',
      },
      plugins: [
        {
          name: 'test-plugin',
          description: 'Test Plugin Description',
          source: './',
          strict: false,
          skills: ['./test-plugin/skill1', './test-plugin/skill2'],
        },
      ],
    };

    await fs.writeFile(
      path.join(marketplacePath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(marketplaceJson, null, 2),
    );

    // 创建 SKILL.md 文件
    await fs.writeFile(
      path.join(marketplacePath, 'test-plugin', 'skill1', 'SKILL.md'),
      '---\nname: skill1\ndescription: Test Skill 1\n---\n\n# Skill 1 Content',
    );
    await fs.writeFile(
      path.join(marketplacePath, 'test-plugin', 'skill2', 'SKILL.md'),
      '---\nname: skill2\ndescription: Test Skill 2\n---\n\n# Skill 2 Content',
    );
  }

  // ============================================================================
  // Bug Fix Tests: extractRepoName
  // ============================================================================

  describe('extractRepoName', () => {
    it('should include owner in ID for GitHub URLs to avoid name collision', () => {
      const managerAny = manager as any;
      // https://github.com/mattpocock/skills.git → "mattpocock-skills"
      expect(managerAny.extractRepoName('https://github.com/mattpocock/skills.git')).toBe('mattpocock-skills');
      // https://github.com/anthropics/skills.git → "anthropics-skills" (no collision!)
      expect(managerAny.extractRepoName('https://github.com/anthropics/skills.git')).toBe('anthropics-skills');
      // https://github.com/user/repo (no .git suffix) → "user-repo"
      expect(managerAny.extractRepoName('https://github.com/user/repo')).toBe('user-repo');
      // URL without .git suffix
      expect(managerAny.extractRepoName('https://github.com/org/my-repo')).toBe('org-my-repo');
    });

    it('should handle SSH-style Git URLs', () => {
      const managerAny = manager as any;
      // git@github.com:mattpocock/skills.git → "mattpocock-skills"
      expect(managerAny.extractRepoName('git@github.com:mattpocock/skills.git')).toBe('mattpocock-skills');
    });

    it('should throw ValidationError for invalid URL', () => {
      const managerAny = manager as any;
      expect(() => managerAny.extractRepoName('not-a-url')).toThrow();
      expect(() => managerAny.extractRepoName('https://github.com/')).toThrow();
    });
  });

  // ============================================================================
  // Bug Fix Tests: addGitMarketplace existence checks
  // ============================================================================

  describe('addGitMarketplace existence checks', () => {
    it('should reject same ID already in settings (different URL)', async () => {
      // Pre-add a marketplace with ID "skills" via local
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'skills');

      // Now try to add a Git marketplace with the same ID "skills"
      const cloneSpy = vi.spyOn(manager as any, 'cloneRepository').mockResolvedValue(undefined);
      await expect(
        manager.addGitMarketplace('https://github.com/different/repo.git', 'skills'),
      ).rejects.toThrow(/already used/);

      cloneSpy.mockRestore();
    });

    it('should suggest update when same ID and same URL', async () => {
      // Pre-add a marketplace with a specific URL
      await createTestMarketplace(testMarketplacePath);
      const url = 'https://github.com/test/repo.git';
      await settingsManager.addMarketplace({
        id: 'test-mp',
        name: 'Test MP',
        source: MarketplaceSource.GIT,
        location: url,
        enabled: true,
        addedAt: new Date().toISOString(),
      });

      // Try to add the same URL with the same ID
      await expect(
        manager.addGitMarketplace(url, 'test-mp'),
      ).rejects.toThrow(/update/);
    });

    it('should reject duplicate URL under different ID', async () => {
      // Pre-add a marketplace with a specific URL
      await createTestMarketplace(testMarketplacePath);
      const url = 'https://github.com/test/repo.git';
      await settingsManager.addMarketplace({
        id: 'mp-a',
        name: 'MP A',
        source: MarketplaceSource.GIT,
        location: url,
        enabled: true,
        addedAt: new Date().toISOString(),
      });

      // Try to add the same URL with a different ID
      const cloneSpy = vi.spyOn(manager as any, 'cloneRepository').mockResolvedValue(undefined);
      await expect(
        manager.addGitMarketplace(url, 'mp-b'),
      ).rejects.toThrow(/already registered/);

      cloneSpy.mockRestore();
    });

    it('should auto-cleanup stale directory when ID not in settings', async () => {
      // Create a stale directory (not registered in settings)
      const staleDir = path.join(SkillsPaths.MARKETPLACE_ROOT, 'stale-mp');
      await fs.ensureDir(staleDir);
      await fs.writeFile(path.join(staleDir, 'junk.txt'), 'stale data');

      // Mock cloneRepository and scanMarketplace
      const cloneSpy = vi.spyOn(manager as any, 'cloneRepository').mockResolvedValue(undefined);
      const scanSpy = vi.spyOn(manager as any, 'scanMarketplace').mockResolvedValue({
        id: 'stale-mp',
        name: 'Stale MP',
        plugins: [],
        source: MarketplaceSource.GIT,
        url: 'https://github.com/test/stale.git',
      });

      // Adding should succeed — stale directory should be cleaned up first
      await manager.addGitMarketplace('https://github.com/test/stale.git', 'stale-mp');

      expect(cloneSpy).toHaveBeenCalled();

      cloneSpy.mockRestore();
      scanSpy.mockRestore();
    });
  });

  // ============================================================================
  // Bug Fix Tests: addLocalMarketplace existence checks
  // ============================================================================

  describe('addLocalMarketplace existence checks', () => {
    it('should reject duplicate ID in settings (different path)', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'local-mp');

      // Try to add another marketplace with the same ID but different path
      const testMarketplacePath2 = path.join(testRoot, 'test-marketplace-2');
      await createTestMarketplace(testMarketplacePath2);

      await expect(
        manager.addLocalMarketplace(testMarketplacePath2, 'local-mp'),
      ).rejects.toThrow(/already used/);
    });

    it('should reject duplicate local path under different ID', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'mp-a');

      // Try to add the same path with a different ID
      await expect(
        manager.addLocalMarketplace(testMarketplacePath, 'mp-b'),
      ).rejects.toThrow(/already registered/);
    });

    it('should suggest update when same ID and same path', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'local-mp');

      // Try to add the same path with the same ID
      await expect(
        manager.addLocalMarketplace(testMarketplacePath, 'local-mp'),
      ).rejects.toThrow(/update/);
    });
  });

  // ============================================================================
  // Existing tests (unchanged)
  // ============================================================================

  describe('addLocalMarketplace', () => {
    it('should add local marketplace successfully', async () => {
      await createTestMarketplace(testMarketplacePath);

      const marketplace = await manager.addLocalMarketplace(testMarketplacePath);

      expect(marketplace.name).toBe('test-marketplace');
      expect(marketplace.source).toBe(MarketplaceSource.LOCAL);
      expect(marketplace.plugins).toHaveLength(1);
      expect(marketplace.plugins[0].name).toBe('test-plugin');
      expect(marketplace.plugins[0].skillPaths).toHaveLength(2);
    });

    it('should save marketplace config', async () => {
      await createTestMarketplace(testMarketplacePath);

      await manager.addLocalMarketplace(testMarketplacePath, 'my-marketplace');

      const marketplaces = await settingsManager.getMarketplaces();
      expect(marketplaces).toHaveLength(1);
      expect(marketplaces[0].id).toBe('my-marketplace');
      expect(marketplaces[0].source).toBe(MarketplaceSource.LOCAL);
    });

    it('should throw error if path does not exist', async () => {
      await expect(
        manager.addLocalMarketplace('/non/existent/path'),
      ).rejects.toThrow();
    });
  });

  describe('getMarketplace', () => {
    it('should get marketplace by id', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'test-mp');

      const marketplace = await manager.getMarketplace('test-mp');

      expect(marketplace.id).toBe('test-mp');
      expect(marketplace.name).toBe('test-marketplace');
    });

    it('should throw error if marketplace not found', async () => {
      await expect(manager.getMarketplace('non-existent')).rejects.toThrow();
    });
  });

  describe('listMarketplaces', () => {
    it('should list all marketplaces', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'test-mp1');

      const testMarketplacePath2 = path.join(testRoot, 'test-marketplace-2');
      await createTestMarketplace(testMarketplacePath2);
      await manager.addLocalMarketplace(testMarketplacePath2, 'test-mp2');

      const marketplaces = await manager.listMarketplaces();

      expect(marketplaces).toHaveLength(2);
      expect(marketplaces.map((m) => m.id)).toContain('test-mp1');
      expect(marketplaces.map((m) => m.id)).toContain('test-mp2');
    });

    it('should return empty array if no marketplaces', async () => {
      const marketplaces = await manager.listMarketplaces();
      expect(marketplaces).toHaveLength(0);
    });
  });

  describe('getPlugins', () => {
    it('should get all plugins from marketplace', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'test-mp');

      const plugins = await manager.getPlugins('test-mp');

      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('test-plugin');
      expect(plugins[0].id).toBe('test-mp:test-plugin');
      expect(plugins[0].skillPaths).toHaveLength(2);
    });
  });

  describe('removeMarketplace', () => {
    it('should remove marketplace config', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'test-mp');

      await manager.removeMarketplace('test-mp');

      const marketplaces = await settingsManager.getMarketplaces();
      expect(marketplaces).toHaveLength(0);
    });

    it('should not delete local files', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'test-mp');

      await manager.removeMarketplace('test-mp', false);

      expect(await fs.pathExists(testMarketplacePath)).toBe(true);
    });
  });

  describe('browseMarketplace', () => {
    it('should return all plugins without query', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'test-mp');

      const plugins = await manager.browseMarketplace('test-mp');

      expect(plugins).toHaveLength(1);
    });

    it('should filter plugins by query', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'test-mp');

      const plugins = await manager.browseMarketplace('test-mp', 'test-plugin');

      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('test-plugin');
    });

    it('should return empty array for non-matching query', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'test-mp');

      const plugins = await manager.browseMarketplace('test-mp', 'non-existent');

      expect(plugins).toHaveLength(0);
    });
  });

  describe('scanMarketplaceDetailed', () => {
    it('should return detailed scan result', async () => {
      await createTestMarketplace(testMarketplacePath);
      await manager.addLocalMarketplace(testMarketplacePath, 'test-mp');

      const result = await manager.scanMarketplaceDetailed('test-mp');

      expect(result.marketplace.id).toBe('test-mp');
      expect(result.pluginCount).toBe(1);
      expect(result.skillCount).toBe(2);
      expect(result.scanDuration).toBeGreaterThanOrEqual(0);
      expect(result.hasErrors).toBe(false);
    });
  });

  describe('fallback logic', () => {
    it('should fallback to skills directory if plugins directory does not exist', async () => {
      await fs.ensureDir(testMarketplacePath);
      await fs.ensureDir(path.join(testMarketplacePath, '.claude-plugin'));
      // Create 'skills' directory instead of 'plugins'
      await fs.ensureDir(path.join(testMarketplacePath, 'skills', 'my-plugin', 'commands'));

      const marketplaceJson = {
        name: 'test-marketplace',
        plugins: [
          {
            name: 'my-plugin',
            source: './plugins/my-plugin', // Points to plugins
            commands: ['./commands/cmd1.md']
          },
        ],
      };

      await fs.writeFile(
        path.join(testMarketplacePath, '.claude-plugin', 'marketplace.json'),
        JSON.stringify(marketplaceJson, null, 2),
      );

      await fs.writeFile(
        path.join(testMarketplacePath, 'skills', 'my-plugin', 'commands', 'cmd1.md'),
        '# Command 1'
      );

      const marketplace = await manager.addLocalMarketplace(testMarketplacePath);
      const plugin = marketplace.plugins[0];

      expect(plugin.name).toBe('my-plugin');
      // Should have resolved to skills directory
      expect(plugin.skillPaths).toHaveLength(1);
      expect(plugin.skillPaths[0].replace(/\\/g, '/')).toContain('skills/my-plugin/commands/cmd1.md');
    });
  });
});
