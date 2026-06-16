/**
 * Skill Hub Tool
 *
 * Search and install skills from the custom-skills registry (hwj123hwj/custom-skills).
 * Uses jsdelivr CDN for China network acceleration, with GitHub raw as fallback.
 */

import {
  BaseTool,
  Icon,
  type ToolResult,
  type ToolCallConfirmationDetails,
  type ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { Config } from '../config/config.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import { getProjectSkillsDir } from '../utils/paths.js';
import fs from 'fs';
import path from 'path';

const REGISTRY_URL = 'https://cdn.jsdelivr.net/gh/hwj123hwj/custom-skills@main/registry/skills.json';
const REGISTRY_FALLBACK_URL = 'https://raw.githubusercontent.com/hwj123hwj/custom-skills/main/registry/skills.json';
const SKILL_URL_TEMPLATE = 'https://cdn.jsdelivr.net/gh/hwj123hwj/custom-skills@main/skills/{skillId}/SKILL.md';
const SKILL_FALLBACK_TEMPLATE = 'https://raw.githubusercontent.com/hwj123hwj/custom-skills/main/skills/{skillId}/SKILL.md';
const SKILL_FILE_URL_TEMPLATE = 'https://cdn.jsdelivr.net/gh/hwj123hwj/custom-skills@main/skills/{skillId}/{filePath}';
const SKILL_FILE_FALLBACK_TEMPLATE = 'https://raw.githubusercontent.com/hwj123hwj/custom-skills/main/skills/{skillId}/{filePath}';
const GIT_TREE_API_URL = 'https://api.github.com/repos/hwj123hwj/custom-skills/git/trees/main?recursive=1';
const FETCH_TIMEOUT_MS = 10000;
const MAX_SEARCH_RESULTS = 20;

// File patterns to skip during install (build artifacts, metadata)
const SKIP_FILE_PATTERNS = [
  /^\.git/,
  /^\.github\//,
  /^\.claude/,
  /^\.claude-plugin/,
  /^src\//,
  /^cli\//,
  /^docs\//,
  /^preview\//,
  /^screenshots\//,
  /^LICENSE$/,
  /^README\.md$/,
  /^README\.en\.md$/,
  /^CONTRIBUTING\.md$/,
  /^\.gitignore$/,
  /^skill\.json$/,
  /^project-introduction\.md$/,
  /^wechat-promo\.md$/,
];

interface SkillRegistryItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  lastUpdated?: string;
}

interface SkillHubParams {
  /** Action to perform: "search" to find skills, "install" to download and install a skill */
  action: 'search' | 'install' | 'list';
  /** Search query keyword (for search action) */
  query?: string;
  /** Skill ID to install (for install action) */
  skillId?: string;
}

/**
 * SkillHubTool - Search and install skills from custom-skills registry
 */
export class SkillHubTool extends BaseTool<SkillHubParams, ToolResult> {
  static readonly Name: string = 'skill_hub';

  constructor(private readonly config: Config) {
    super(
      SkillHubTool.Name,
      'SkillHub',
      '从 custom-skills 仓库搜索并按需安装技能。覆盖 51 个精选技能：图像、视频、音频、文档、学术搜索、开发工具等。使用 jsdelivr CDN 加速国内访问。action="search" 搜索技能，action="install" 安装技能到本地。',
      Icon.List,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            description: '操作类型: "search" 搜索技能, "install" 安装技能, "list" 列出全部技能',
            enum: ['search', 'install', 'list'],
          },
          query: {
            type: Type.STRING,
            description: '搜索关键词（用于 search 操作），如 "生图"、"OCR"、"视频剪辑"',
          },
          skillId: {
            type: Type.STRING,
            description: '要安装的技能 ID（用于 install 操作），如 "image-provider"、"paddleocr-text-recognition"',
          },
        },
        required: ['action'],
      },
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  override validateToolParams(params: SkillHubParams): string | null {
    if (!params.action) {
      return 'Missing required parameter: action';
    }
    if (params.action !== 'search' && params.action !== 'install' && params.action !== 'list') {
      return `Invalid action: "${params.action}". Must be "search" or "install".`;
    }
    if (params.action === 'search' && !params.query) {
      return 'Search action requires a "query" parameter.';
    }
    if (params.action === 'install' && !params.skillId) {
      return 'Install action requires a "skillId" parameter.';
    }
    return null;
  }

  override getDescription(params: SkillHubParams): string {
    if (params.action === 'list') {
      return 'Listing all skills in custom-skills registry';
    }
    if (params.action === 'search') {
      return `Searching custom-skills registry for: "${params.query}"`;
    }
    return `Installing skill: "${params.skillId}" from custom-skills registry`;
  }

  override toolLocations(params: SkillHubParams): ToolLocation[] {
    if (params.action === 'install') {
      const projectSkillsDir = getProjectSkillsDir(this.config.getProjectRoot());
      return [{ path: path.join(projectSkillsDir, params.skillId!, 'SKILL.md') }];
    }
    return [];
  }

  override async shouldConfirmExecute(
    params: SkillHubParams,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (params.action === 'search' || params.action === 'list') {
      return false; // Read-only, no confirmation needed
    }

    // Install action: confirm before writing files
    return {
      type: 'info',
      title: `Install Skill: ${params.skillId}`,
      prompt: `将安装技能 "${params.skillId}" 到项目目录 .easycode/skills/${params.skillId}/。安装后重启会话即可使用。`,
      urls: [SKILL_URL_TEMPLATE.replace('{skillId}', params.skillId!).replace('{filePath}', 'SKILL.md')],
      onConfirm: async () => {},
    };
  }

  override async execute(
    params: SkillHubParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    if (params.action === 'list') {
      return this.executeList(signal);
    }

    if (params.action === 'search') {
      return this.executeSearch(params.query!, signal);
    }

    return this.executeInstall(params.skillId!, signal);
  }

  /**
   * List all skills in the registry
   */
  private async executeList(signal: AbortSignal): Promise<ToolResult> {
    try {
      const registry = await this.fetchRegistry(signal);
      if (!registry) {
        return {
          llmContent: 'Error: 无法获取技能仓库索引。请检查网络连接。',
          returnDisplay: 'Registry fetch failed',
        };
      }

      const lines: string[] = [
        `技能市场共有 ${registry.length} 个技能：`,
        '',
      ];

      for (const skill of registry) {
        lines.push(`- **${skill.id}**: ${skill.description}`);
        lines.push(`  标签: ${skill.tags.join(', ')}`);
      }

      lines.push('');
      lines.push('使用 `skill_hub(action="install", skillId="技能ID")` 安装技能。');

      return {
        llmContent: lines.join('\n'),
        returnDisplay: `Found ${registry.length} skill(s)`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `列表获取失败: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  /**
   * Search skills by keyword
   */
  private async executeSearch(query: string, signal: AbortSignal): Promise<ToolResult> {
    try {
      const registry = await this.fetchRegistry(signal);
      if (!registry) {
        return {
          llmContent: 'Error: 无法获取技能仓库索引。请检查网络连接。',
          returnDisplay: 'Registry fetch failed',
        };
      }

      const lowerQuery = query.toLowerCase();
      const matches: SkillRegistryItem[] = [];

      for (const skill of registry) {
        const nameMatch = skill.name.toLowerCase().includes(lowerQuery);
        const descMatch = skill.description.toLowerCase().includes(lowerQuery);
        const tagMatch = skill.tags.some(t => t.toLowerCase().includes(lowerQuery));
        const idMatch = skill.id.toLowerCase().includes(lowerQuery);

        if (nameMatch || descMatch || tagMatch || idMatch) {
          matches.push(skill);
        }
      }

      if (matches.length === 0) {
        return {
          llmContent: `未找到匹配 "${query}" 的技能。尝试使用不同的关键词，或使用 action="search" query="list" 查看所有技能。`,
          returnDisplay: `No matches for "${query}"`,
        };
      }

      // Limit results
      const results = matches.slice(0, MAX_SEARCH_RESULTS);

      const lines: string[] = [
        `找到 ${results.length} 个匹配 "${query}" 的技能：`,
        '',
      ];

      for (const skill of results) {
        lines.push(`- **${skill.id}**: ${skill.description}`);
        lines.push(`  标签: ${skill.tags.join(', ')}`);
        lines.push('');
      }

      if (matches.length > MAX_SEARCH_RESULTS) {
        lines.push(`(还有 ${matches.length - MAX_SEARCH_RESULTS} 个结果未显示)`);
      }

      lines.push('使用 `skill_hub(action="install", skillId="技能ID")` 安装技能。');

      return {
        llmContent: lines.join('\n'),
        returnDisplay: `Found ${results.length} skill(s) matching "${query}"`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `搜索失败: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  /**
   * Install a skill by downloading all files from CDN
   */
  private async executeInstall(skillId: string, signal: AbortSignal): Promise<ToolResult> {
    const projectSkillsDir = getProjectSkillsDir(this.config.getProjectRoot());
    const targetDir = path.join(projectSkillsDir, skillId);
    const targetSkillMd = path.join(targetDir, 'SKILL.md');

    // Check if already installed
    if (fs.existsSync(targetSkillMd)) {
      return {
        llmContent: `技能 "${skillId}" 已安装。路径: ${targetSkillMd}\n重启会话后 SkillLoader 会自动发现此技能，使用 use_skill("${skillId}") 加载。`,
        returnDisplay: `Skill "${skillId}" already installed`,
      };
    }

    try {
      // Fetch SKILL.md content
      const skillUrl = SKILL_URL_TEMPLATE.replace('{skillId}', skillId);
      const fallbackUrl = SKILL_FALLBACK_TEMPLATE.replace('{skillId}', skillId);

      let content: string | null = null;

      // Try jsdelivr CDN first
      try {
        const response = await fetchWithTimeout(skillUrl, FETCH_TIMEOUT_MS);
        if (response.ok) {
          content = await response.text();
        }
      } catch {
        // CDN failed, try fallback
      }

      // Fallback to GitHub raw
      if (!content) {
        try {
          const response = await fetchWithTimeout(fallbackUrl, FETCH_TIMEOUT_MS);
          if (response.ok) {
            content = await response.text();
          }
        } catch {
          // Both failed
        }
      }

      if (!content) {
        return {
          llmContent: `无法下载技能 "${skillId}"。jsdelivr CDN 和 GitHub raw 均失败。请检查网络连接或确认技能 ID 是否正确。`,
          returnDisplay: `Download failed for "${skillId}"`,
        };
      }

      // Write SKILL.md to local directory
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetSkillMd, content, 'utf-8');

      // Download additional files (scripts, assets, references, etc.) via GitHub API
      let additionalCount = 0;
      try {
        const fileList = await this.fetchFileList(skillId, signal);
        if (fileList) {
          for (const filePath of fileList) {
            if (filePath === 'SKILL.md') continue; // Already downloaded
            const fileContent = await this.fetchSkillFile(skillId, filePath, signal);
            if (fileContent !== null) {
              const targetPath = path.join(targetDir, filePath);
              fs.mkdirSync(path.dirname(targetPath), { recursive: true });
              fs.writeFileSync(targetPath, fileContent, 'utf-8');
              additionalCount++;
            }
          }
        }
      } catch (e) {
        // Non-fatal: skill is still usable with just SKILL.md
      }

      const fileMsg = additionalCount > 0 ? ` 含 ${additionalCount} 个附加文件。` : '';
      return {
        llmContent: `技能 "${skillId}" 已成功安装到 ${targetSkillMd}。${fileMsg}\n\n重启会话后 SkillLoader 会自动发现此技能，使用 use_skill("${skillId}") 加载并使用。`,
        returnDisplay: `Skill "${skillId}" installed successfully${additionalCount ? ` (+${additionalCount} files)` : ''}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `安装失败: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  /**
   * Fetch list of files in a skill directory using GitHub API
   */
  private async fetchFileList(skillId: string, signal: AbortSignal): Promise<string[] | null> {
    try {
      const response = await fetchWithTimeout(GIT_TREE_API_URL, FETCH_TIMEOUT_MS);
      if (!response.ok) return null;
      const data = await response.json() as { tree: Array<{ path: string; type: string }> };
      const prefix = `skills/${skillId}/`;
      return data.tree
        .filter((item) => item.type === 'blob' && item.path.startsWith(prefix))
        .map((item) => item.path.slice(prefix.length))
        .filter((p) => !SKIP_FILE_PATTERNS.some((r) => r.test(p)));
    } catch {
      return null;
    }
  }

  /**
   * Fetch a single skill file from CDN (with fallback)
   */
  private async fetchSkillFile(skillId: string, filePath: string, signal: AbortSignal): Promise<string | null> {
    const cdnUrl = SKILL_FILE_URL_TEMPLATE.replace('{skillId}', skillId).replace('{filePath}', filePath);
    const fallbackUrl = SKILL_FILE_FALLBACK_TEMPLATE.replace('{skillId}', skillId).replace('{filePath}', filePath);

    try {
      const response = await fetchWithTimeout(cdnUrl, FETCH_TIMEOUT_MS);
      if (response.ok) return await response.text();
    } catch { /* fall through */ }

    try {
      const response = await fetchWithTimeout(fallbackUrl, FETCH_TIMEOUT_MS);
      if (response.ok) return await response.text();
    } catch { /* fall through */ }

    return null;
  }

  /**
   * Fetch registry JSON from CDN (with fallback)
   */
  private async fetchRegistry(signal: AbortSignal): Promise<SkillRegistryItem[] | null> {
    // Try jsdelivr CDN first
    try {
      const response = await fetchWithTimeout(REGISTRY_URL, FETCH_TIMEOUT_MS);
      if (response.ok) {
        const json = await response.json();
        return json as SkillRegistryItem[];
      }
    } catch {
      // CDN failed
    }

    // Fallback to GitHub raw
    try {
      const response = await fetchWithTimeout(REGISTRY_FALLBACK_URL, FETCH_TIMEOUT_MS);
      if (response.ok) {
        const json = await response.json();
        return json as SkillRegistryItem[];
      }
    } catch {
      // Both failed
    }

    return null;
  }
}
