# 技能同步架构改进方案

## 背景

### 当前问题

在使用 hwjcode 过程中，发现技能管理存在以下问题：

#### 1. 技能更新依赖记忆

| 场景 | 有记忆？ | 会迭代技能？ | 会推送更新？ |
|------|---------|-------------|-------------|
| 主实例（直接对话） | ✅ 有 | ✅ 会 | ✅ 会 |
| 项目级实例（hwjcode开发） | ❌ 没有 | ❌ 不会 | ❌ 不会 |

**核心矛盾：** 技能更新依赖 AI 的记忆，但项目级实例没有这个记忆。

#### 2. 硬编码路径问题

当前技能源仓库（custom-skills）克隆到 `/home/q/custom-skills`，这是硬编码路径：
- ❌ 不同电脑路径不同
- ❌ 不同用户路径不同
- ❌ 无法跨环境一致

#### 3. 缺乏自动同步机制

- 技能安装后，不会自动迭代改进
- 本地修改不会自动同步到仓库
- 仓库更新不会自动推送到 GitHub

---

## 解决方案

### 核心思路

**把技能源仓库做成 hwjcode 的内置模块，存放在系统目录 `~/.easycode-user/custom-skills/`**

### 目录结构

```
~/.easycode-user/
├── skills/                  # 已安装的技能（现有）
│   ├── butler/
│   ├── bilibili-cli/
│   └── ...
├── custom-skills/           # 技能源仓库（新增）
│   ├── skills/
│   │   ├── butler/
│   │   ├── bilibili-cli/
│   │   └── ...
│   ├── registry/
│   │   └── skills.json
│   └── ...
├── tmp/
└── ...
```

### 优势

| 优势 | 说明 |
|------|------|
| ✅ 无硬编码路径 | `~/.easycode-user/` 是 hwjcode 系统目录，始终一致 |
| ✅ 跨环境一致 | 无论哪台电脑、哪个用户，路径都一样 |
| ✅ 内置模块 | 技能源仓库是系统的一部分 |
| ✅ 本地优先 | 安装技能时先从本地复制，速度快 |
| ✅ 自动同步 | 更新后可自动推送到 GitHub |

---

## 实现方案

### 第一步：迁移技能源仓库

```bash
# 把 custom-skills 迁移到系统目录
mv /home/q/custom-skills ~/.easycode-user/custom-skills

# 创建软链接保持向后兼容（可选）
ln -s ~/.easycode-user/custom-skills /home/q/custom-skills
```

### 第二步：添加路径常量

**文件：`packages/core/src/utils/paths.ts`**

```typescript
export const GEMINI_DIR = '.easycode-user';
export const PROJECT_DIR_PREFIX = '.easycode';
export const CUSTOM_SKILLS_REPO = 'custom-skills';  // 新增

// 获取技能源仓库路径
export function getCustomSkillsRepo(): string {
  return path.join(os.homedir(), GEMINI_DIR, CUSTOM_SKILLS_REPO);
}

// 获取技能源仓库中的技能路径
export function getCustomSkillPath(skillId: string): string {
  return path.join(getCustomSkillsRepo(), 'skills', skillId);
}
```

### 第三步：更新 skill-hub.ts

**文件：`packages/core/src/tools/skill-hub.ts`**

```typescript
import { getCustomSkillsRepo, getCustomSkillPath } from '../utils/paths.js';

// 本地仓库路径
const LOCAL_SKILLS_REPO = getCustomSkillsRepo();

// 安装技能时优先从本地复制
async installSkill(skillId: string): Promise<ToolResult> {
  const localPath = getCustomSkillPath(skillId);

  // 1. 检查本地仓库是否存在
  if (fs.existsSync(localPath)) {
    console.log(`[SkillHub] Installing from local repo: ${localPath}`);
    return this.copyFromLocal(localPath, skillId);
  }

  // 2. 回退到 GitHub 下载
  console.log(`[SkillHub] Local not found, downloading from GitHub...`);
  return this.downloadFromGitHub(skillId);
}

// 从本地仓库复制技能
private async copyFromLocal(localPath: string, skillId: string): Promise<ToolResult> {
  const targetDir = path.join(getProjectSkillsDir(), skillId);

  // 复制目录
  await fs.copy(localPath, targetDir);

  return {
    success: true,
    message: `Skill "${skillId}" installed from local repo`,
    installPath: targetDir
  };
}
```

### 第四步：新增 skill-sync 工具

**文件：`packages/core/src/tools/skill-sync.ts`**

```typescript
import { BaseTool, type ToolResult } from './tools.js';
import { getCustomSkillsRepo, getCustomSkillPath } from '../utils/paths.js';
import { getProjectSkillsDir } from '../utils/paths.js';
import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';

interface SkillSyncParams {
  /** 技能名称 */
  skillName: string;
  /** 操作类型 */
  action: 'sync' | 'push' | 'status';
}

/**
 * SkillSyncTool - 同技技能到技能源仓库并推送到 GitHub
 */
export class SkillSyncTool extends BaseTool<SkillSyncParams, ToolResult> {
  static readonly Name = 'skill-sync';

  constructor(private readonly config: Config) {
    super(
      SkillSyncTool.Name,
      'SkillSync',
      '同步技能修改到技能源仓库（~/.easycode-user/custom-skills/）并推送到 GitHub',
      Icon.Skills,
      {
        type: Type.OBJECT,
        properties: {
          skillName: {
            type: Type.STRING,
            description: '技能名称（如 butler）',
          },
          action: {
            type: Type.STRING,
            enum: ['sync', 'push', 'status'],
            description: '操作类型：sync=同步到仓库，push=推送到 GitHub，status=查看状态',
          },
        },
        required: ['skillName', 'action'],
      },
      true, // 需要确认
      ToolLocation.MAIN
    );
  }

  getDescription(params: SkillSyncParams): string {
    return `${params.action} skill: ${params.skillName}`;
  }

  async execute(params: SkillSyncParams): Promise<ToolResult> {
    const { skillName, action } = params;

    try {
      switch (action) {
        case 'sync':
          return await this.syncToRepo(skillName);
        case 'push':
          return await this.pushToGitHub(skillName);
        case 'status':
          return await this.checkStatus(skillName);
        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // 同步技能到本地仓库
  private async syncToRepo(skillName: string): Promise<ToolResult> {
    const sourceDir = path.join(getProjectSkillsDir(), skillName);
    const targetDir = getCustomSkillPath(skillName);

    // 检查源目录
    if (!fs.existsSync(sourceDir)) {
      return { success: false, error: `Skill not found: ${sourceDir}` };
    }

    // 复制到仓库
    await fs.copy(sourceDir, targetDir, { overwrite: true });

    return {
      success: true,
      message: `Skill "${skillName}" synced to repo: ${targetDir}`,
      source: sourceDir,
      target: targetDir
    };
  }

  // 推送到 GitHub
  private async pushToGitHub(skillName: string): Promise<ToolResult> {
    const repoDir = getCustomSkillsRepo();

    // 先同步
    await this.syncToRepo(skillName);

    // Git 操作
    await execa('git', ['add', `skills/${skillName}`], { cwd: repoDir });
    await execa('git', ['commit', '-m', `update skill: ${skillName}`], { cwd: repoDir });
    await execa('git', ['push', 'origin', 'main'], { cwd: repoDir });

    return {
      success: true,
      message: `Skill "${skillName}" pushed to GitHub`
    };
  }

  // 检查状态
  private async checkStatus(skillName: string): Promise<ToolResult> {
    const sourceDir = path.join(getProjectSkillsDir(), skillName);
    const targetDir = getCustomSkillPath(skillName);

    const sourceExists = fs.existsSync(sourceDir);
    const targetExists = fs.existsSync(targetDir);

    return {
      success: true,
      skillName,
      localPath: sourceDir,
      repoPath: targetDir,
      localExists: sourceExists,
      repoExists: targetExists,
      inSync: sourceExists && targetExists
    };
  }
}
```

### 第五步：注册新工具

**文件：`packages/core/src/tools/index.ts`**

```typescript
import { SkillSyncTool } from './skill-sync.js';

// 在工具列表中添加
export const builtinTools = [
  // ... 其他工具
  SkillSyncTool,
];
```

### 第六步：更新系统提示词

**文件：`packages/core/src/skills/skills-integration.ts`**

```typescript
const SKILL_MANAGEMENT_RULES = `
## 技能管理规则

当发现技能问题或需要优化时：
1. 修复本地技能：~/.easycode-user/skills/xxx
2. 同步到技能源仓库：使用 skill-sync 工具
   - skill-sync(skillName="xxx", action="sync")
3. 推送到 GitHub：
   - skill-sync(skillName="xxx", action="push")

技能源仓库位置：~/.easycode-user/custom-skills/
这是系统固定路径，无需记忆。
`;
```

---

## 新的工作流

```
用户使用技能
    ↓
发现问题
    ↓
修复本地技能 (~/.easycode-user/skills/xxx)
    ↓
调用 skill-sync 工具
    ├── sync: 同步到仓库 (~/.easycode-user/custom-skills/skills/xxx)
    └── push: 推送到 GitHub
    ↓
完成
```

---

## 测试验证

### 测试场景1：主实例

1. 修复技能
2. 调用 `skill-sync(skillName="butler", action="sync")`
3. 调用 `skill-sync(skillName="butler", action="push")`
4. 验证 GitHub 已更新

### 测试场景2：项目级实例

1. 修复技能
2. 调用 `skill-sync(skillName="butler", action="sync")`
3. 调用 `skill-sync(skillName="butler", action="push")`
4. 验证 GitHub 已更新

**关键点：** 两个场景都使用工具，不依赖记忆。

---

## 迁移清单

- [ ] 迁移 custom-skills 到 `~/.easycode-user/custom-skills/`
- [ ] 添加路径常量 `getCustomSkillsRepo()`
- [ ] 更新 skill-hub.ts 支持本地复制
- [ ] 新增 skill-sync 工具
- [ ] 注册新工具
- [ ] 更新系统提示词
- [ ] 测试主实例场景
- [ ] 测试项目级实例场景
- [ ] 更新文档

---

## 总结

这个方案的核心优势：

1. **无硬编码路径** - 使用系统目录 `~/.easycode-user/`
2. **跨环境一致** - 无论哪台电脑，路径都一样
3. **不依赖记忆** - 通过工具实现同步
4. **自动化** - 一键同步+推送

这样，无论是主实例还是项目级实例，都能正确地同步和推送技能更新。
