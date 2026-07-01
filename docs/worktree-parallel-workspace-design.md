# Git Worktree 并行工作区隔离 —— 设计与实现文档

## 1. 目标

为 Easy Code 引入基于 Git Worktree 的并行 Agent 工作区隔离能力，让多个 sub-agent / 远程 session 在独立的 worktree 中并行开发，互不干扰。

## 2. 现状分析

### 2.1 已具备的基础能力

| 能力 | 位置 | 说明 |
|------|------|------|
| `WorkflowAgentBridge.runParallel()` | `packages/core/src/core/workflowAgentBridge.ts` | 并行 sub-agent 调度，但共享同一 workspace |
| `remoteSession.buildIsolatedConfig()` | `packages/cli/src/remote/remoteSession.ts` | 远程 session 隔离 Config/ToolRegistry，但仍共享物理目录 |
| `resolveGitDir()` / `findGitRoot()` | `packages/core/src/utils/gitUtils.ts` | 已支持 worktree 的 `.git` 文件格式检测 |
| `Config` 构造参数 | `packages/core/src/config/config.ts` | Config 构造时固化 `targetDir`（`private readonly`），需支持克隆 |

### 2.2 核心差距

- 没有 `git worktree add/remove` 的封装
- 没有 worktree 生命周期管理
- SubAgent / WorkflowAgentBridge 未感知 worktree
- 没有 Config 克隆机制（保留 auth/tools/settings，切换 targetDir）

## 3. 参考实现

MimoCode (`XiaomiMiMo/MiMo-Code`, `packages/opencode/src/worktree/index.ts`) 提供了成熟的 worktree 实现参考：

| 特性 | MimoCode 做法 | 我们的对应 |
|------|--------------|-----------|
| worktree 目录 | `<data>/worktree/<projectID>/<slug>` (全局数据目录) | `.easycode/worktrees/<slug>` (项目内) |
| 分支命名 | `mimocode/<slug>` | `easycode/<slug>` |
| 并发控制 | **无显式锁**——单进程 HTTP server，Node.js 事件循环天然串行化 git spawn | Promise 队列 per git root（Easy Code 多 sub-agent 并发场景特有） |
| 状态追踪 | SQLite (ProjectTable) | 内存 Map + 文件清单 |
| 启动初始化 | 项目 start command + 自定义 startCommand，**异步 fork** | `npm install` + 自定义脚本 |
| 清理 | `git fsmonitor--daemon stop` → `worktree remove --force` → `branch -D` → `fs.rm` | 同（增加 fsmonitor 处理） |
| 重置 | `fetch` → `reset --hard` → `clean -ffdx` → **submodule 三重处理** → `status` 校验 | 同（增加 submodule 处理） |
| 路径归一化 | `fs.realPath` + `path.normalize` + Windows 小写化 | 同（canonical path） |
| 事件通知 | `worktree.ready` / `worktree.failed` via GlobalBus | 预留事件接口 |
| 改动检测 | `isPristine(dir, base)` 检查 git status + HEAD | 同 |

**关键差异**：MimoCode 是 C/S 架构（opencode server + TUI/app 前端），worktree 创建是单一 HTTP 请求，天然串行。Easy Code 是单进程多 sub-agent 并发，**必须引入显式并发控制**。

## 4. 架构设计

### 4.1 组件关系图

```
┌─────────────────────────────────────────────┐
│  WorkflowTool (workflow.ts)                  │
│  ┌─ worktree_mode: true ──────────────────┐ │
│  │  WorkflowAgentBridge.runParallel()     │ │
│  │  ┌──────────────────────────────────┐  │ │
│  │  │  WorktreeManager.create()        │  │ │
│  │  │  → Config.cloneForWorktree(dir)  │  │ │
│  │  │  → SubAgent(config, ...)         │  │ │
│  │  │  → SubAgent.run()               │  │ │
│  │  │  → WorktreeManager.commitAnd... │  │ │
│  │  │     Cleanup(info)               │  │ │
│  │  └──────────────────────────────────┘  │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  remoteSession.ts (Feishu / 远程)            │
│  ┌─ worktree_mode: true ──────────────────┐ │
│  │  WorktreeManager.create()              │ │
│  │  → Config.cloneForWorktree(dir)        │ │
│  │  → geminiClient 指向 worktree          │ │
│  │  → session 结束后 cleanup              │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  delegate_to_agent (Claude Code / Codex)     │
│  ┌─ worktree_mode: true ──────────────────┐ │
│  │  WorktreeManager.create()              │ │
│  │  → delegate with cwd = worktree dir    │ │
│  │  → 结束后 commit + cleanup             │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 4.2 新增文件

| 文件 | 职责 | 预估行数 |
|------|------|---------|
| `packages/core/src/utils/worktreeManager.ts` | Git worktree CRUD、锁、命名、清理、submodule 处理 | ~350 |
| `packages/core/src/utils/__tests__/worktreeManager.test.ts` | 单元测试 | ~200 |

### 4.3 修改文件

| 文件 | 改动 | 影响范围 |
|------|------|---------|
| `packages/core/src/config/config.ts` | 新增 `cloneForWorktree(targetDir)` | 新增方法，不改现有逻辑 |
| `packages/core/src/core/workflowAgentBridge.ts` | `WorkflowAgentRunOptions` 新增 `worktree?` 字段 | 向后兼容 |
| `packages/core/src/tools/workflow.ts` | `WorkflowToolParams` 新增 `worktree_mode?` | 向后兼容 |
| `packages/cli/src/remote/remoteSession.ts` | 新增 `worktreeMode` 分支 | 可选功能 |

## 5. 核心模块设计

### 5.1 WorktreeManager

```typescript
// packages/core/src/utils/worktreeManager.ts

export interface WorktreeInfo {
  name: string;        // 唯一名称，如 "fix-auth-bug"
  branch: string;      // 分支名，如 "easycode/fix-auth-bug"
  directory: string;   // worktree 绝对路径（canonical）
}

export interface WorktreeCreateOptions {
  /** 可读名称，用于生成 branch 和目录名 */
  name?: string;
  /** 创建 worktree 的基准引用，默认 HEAD */
  baseRef?: string;
  /** 创建 worktree 后执行的初始化命令（如 npm install） */
  startCommand?: string;
  /** 是否异步执行 boot（checkout + startCommand），默认 true */
  asyncBoot?: boolean;
  /** 是否在 Agent 结束后自动提交修改到分支并清理 worktree */
  autoCommitAndCleanup?: boolean;
}

export interface WorktreeCleanupResult {
  success: boolean;
  committed: boolean;     // 是否实际产生了 commit（false = pristine，无改动）
  branchName?: string;    // 如果 committed，返回提交所在分支名
  commitSha?: string;     // 提交 SHA
  error?: string;
}

export class WorktreeManager {
  // ── 创建 ──
  async create(options?: WorktreeCreateOptions): Promise<WorktreeInfo>

  // ── 提交 + 清理 ──
  // 先用 isPristine 检查，无改动直接 cleanup；有改动才 commit
  async commitAndCleanup(info: WorktreeInfo, commitMessage?: string): Promise<WorktreeCleanupResult>

  // ── 仅清理（不提交，丢弃修改） ──
  async cleanup(info: WorktreeInfo): Promise<void>

  // ── 列出当前项目的所有 worktree ──
  async list(): Promise<WorktreeInfo[]>

  // ── 重置 worktree 到指定引用（含 submodule 处理） ──
  async reset(info: WorktreeInfo, targetRef?: string): Promise<void>

  // ── 检查 worktree 是否有改动 ──
  async isPristine(directory: string, baseRef?: string): Promise<boolean>

  // ── 检查是否在 git 仓库中 ──
  static isGitRepo(): boolean

  // ── 获取 worktree 存储根目录 ──
  static getWorktreesRoot(): string

  // ── 路径归一化（symlink 解析 + Windows 小写化） ──
  private static canonical(input: string): string
}
```

### 5.2 命名策略

```
目录: .easycode/worktrees/<slugified-name>
分支: easycode/<slugified-name>
```

**slugify 规则**（参考 MimoCode `worktree/index.ts`）：
- 小写化
- `[^a-z0-9]+` → `-`
- 去首尾 `-`
- slug 为空时（如纯中文/纯特殊字符）直接使用随机 slug
- 冲突时追加随机后缀（如 `-a3f2`），最多重试 26 次

**示例**：
- `name = "Fix Auth Bug"` → slug `fix-auth-bug` → branch `easycode/fix-auth-bug`, dir `.easycode/worktrees/fix-auth-bug`
- `name = "重构用户模块"` → slug 为空（中文被 `[^a-z0-9]` 全部替换）→ fallback 到随机名如 `a3f2k9` → branch `easycode/a3f2k9`
- `name = "feat-123 支付"` → slug `feat-123`（"支付" 被替换为尾部 `-` 并 trim）→ branch `easycode/feat-123`

> **注意**：`[^a-z0-9]+` 规则会吃掉所有非 ASCII 字符（含中文、emoji 等）。这是 MimoCode 的原始行为。如果未来需要支持 Unicode slug，可以改为 `[^a-z0-9\p{L}]+`（保留字母类字符），但分支名含非 ASCII 可能在某些 git hooks / CI 中引发问题，暂时维持 ASCII-only。

### 5.3 并发锁

**背景**：MimoCode 作为单进程 HTTP server，worktree 操作由 REST 请求触发，Node.js 事件循环天然串行化 git spawn，因此**无需显式锁**。

Easy Code 的场景不同：多个 sub-agent 在同一进程内并发执行，`git worktree add` 在同一父 repo 上并发会竞争 `.git/index.lock`。因此引入基于 git root 的 Promise 队列。

```typescript
// worktreeManager.ts 内部

// 使用 WeakRef + FinalizationRegistry 防止 Map 无限增长
const MAX_LOCK_ENTRIES = 64;
const locks = new Map<string, { promise: Promise<void>; count: number }>();

async function acquireLock(gitRoot: string): Promise<() => void> {
  const key = WorktreeManager.canonical(gitRoot);

  let entry = locks.get(key);
  if (!entry) {
    entry = { promise: Promise.resolve(), count: 0 };
    locks.set(key, entry);
  }

  // LRU 淘汰：超过上限时清理 count === 0 的条目
  if (locks.size > MAX_LOCK_ENTRIES) {
    for (const [k, v] of locks) {
      if (v.count === 0 && k !== key) locks.delete(k);
    }
  }

  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  entry.count++;
  entry.promise = entry.promise.then(() => next);
  await entry.promise;
  return () => {
    entry!.count--;
    release();
  };
}
```

### 5.4 创建流程

```
1. 检查是否在 git 仓库（否则拒绝）
2. slugify(name)，如果 slug 为空则使用随机 slug
3. 检查 directory 是否已存在（使用 canonical path，解析 symlink）
4. 检查 branch ref 是否已存在（git show-ref --verify）
   → 冲突则追加随机后缀重试，最多 26 次
5. 验证 .easycode/worktrees/ 已被 .gitignore 忽略（若否，自动追加并提示）
6. 获取并发锁（per git root）
7. git worktree add --no-checkout -b <branch> <directory>
8. 释放锁
9. git reset --hard（在 worktree 目录下，填充文件）
10. 如果 asyncBoot=true（默认）：
    → fork startCommand 到后台，立即返回 WorktreeInfo
    否则：同步等待 startCommand 完成
11. 发出 worktree.ready 事件
12. 返回 WorktreeInfo
```

### 5.5 清理流程

```
1. 如果 autoCommitAndCleanup：
   a. 调用 isPristine(directory) 检查是否有改动
   b. 如果 pristine（无改动）→ 跳过 commit，直接 cleanup，返回 committed: false
   c. 如果有改动：
      i.  git -C <directory> add -A
      ii. git -C <directory> commit -m "<message>"（不使用 --allow-empty）
      iii.记录 branchName 和 commitSha
2. 获取并发锁（per git root）
3. git fsmonitor--daemon stop（在 worktree 目录下）
   → 防止 Windows 上 fsmonitor daemon 锁定目录
4. git worktree remove --force <directory>
5. 如果失败，直接 fs.rm <directory>（带 maxRetries=5）
6. git branch -D <branch>（在主 worktree 中）
   → 注意：如果 commitAndCleanup 保留了分支，跳过此步
7. 释放锁
8. 返回 CleanupResult
```

### 5.6 重置流程（含 submodule 处理）

参考 MimoCode `reset()` 实现，重置到默认分支（或指定 ref）：

```
1. 拒绝重置主 workspace（directory === primary worktree）
2. 通过 git worktree list --porcelain 定位 worktree 条目
3. 确定 base ref（默认分支 or 指定 ref）：
   → git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'
   → 或从项目配置读取
4. 如果是远程分支，先 fetch 最新：
   → git fetch <remote> <branch>
5. git reset --hard <base-ref>（在 worktree 目录下）
6. git clean -ffdx（清除未跟踪文件）
   → 如果失败（文件被锁），解析 stderr 提取失败文件，prune 后重试
7. submodule 三重处理：
   a. git submodule update --init --recursive --force
   b. git submodule foreach --recursive git reset --hard
   c. git submodule foreach --recursive git clean -fdx
8. git status --porcelain 校验 worktree 是否干净
   → 如果仍有残留修改，抛出 ResetFailedError
9. 重新执行 startCommand
```

### 5.7 Config 克隆

> **重要**：不能简单 spread `originalParams`。Config 有 20+ 个 `private readonly` 字段，构造参数与最终字段之间有转换逻辑。参考项目内已有的 `remoteSession.buildIsolatedConfig()` 做法，**手动逐字段继承**。

```typescript
// packages/core/src/config/config.ts 新增方法

/**
 * 为 worktree 派生一个专属 Config 实例。
 *
 * 采用与 remoteSession.buildIsolatedConfig() 相同的逐字段继承策略，
 * 而非 spread originalParams（后者会丢失运行时转换的状态）。
 *
 * 保留：auth, tools, MCP servers, model overrides, proxy, sandbox...
 * 切换：targetDir / cwd → worktree 目录
 * 重新加载：项目级记忆文件（DEEPV.md / AGENTS.md）
 */
async cloneForWorktree(targetDir: string): Promise<Config> {
  // 1. 加载 worktree 目录的项目级记忆
  const sessionMemory = await loadProjectMemory(targetDir);

  // 2. 逐字段继承（与 buildIsolatedConfig 一致）
  return new Config({
    // 标识
    sessionId: this.getSessionId(),
    cwd: targetDir,
    targetDir,                          // ← 关键差异

    // 模型
    model: this.getModel(),
    embeddingModel: this.getEmbeddingModel?.(),
    customModels: this.getCustomModels?.() ?? [],
    cloudModels: this.getCloudModels?.() ?? [],
    modelOverrides: this.getModelOverrides?.() ?? [],

    // 工具 / MCP
    mcpServers: this.getMcpServers?.(),
    coreTools: this.getCoreTools?.(),
    excludeTools: this.getExcludeTools?.(),

    // 代理
    proxy: this.getProxy?.(),
    customProxyServerUrl: this.getCustomProxyServerUrl?.(),

    // 沙箱
    sandbox: this.getSandbox?.(),

    // 记忆（重新加载）
    userMemory: sessionMemory.userMemory,
    memoryTokenCount: sessionMemory.memoryTokenCount,
    geminiMdFileCount: sessionMemory.geminiMdFileCount,

    // 调试
    debugMode: this.getDebugMode?.() ?? false,
  });
}
```

### 5.8 GeminiClient 与 cwd 问题

`WorkflowAgentBridge.run()` 当前共享同一个 `geminiClient` 实例。clone Config 后，targetDir 已指向 worktree 目录，但以下 geminiClient 内部状态仍指向原目录：

| 组件 | 是否需隔离 | 方案 |
|------|-----------|------|
| 文件操作工具（read/write/search） | ✅ 是 | 这些工具通过 `config.getWorkingDir()` 定位文件，clone Config 后自动正确 |
| 文件 watcher | ⚠️ 需评估 | watcher 监听原目录变更；worktree 内的修改不会触发，但 sub-agent 通常不需要监听 |
| LSP server | ⚠️ 需评估 | LSP 绑定到原 workspace；worktree 内的代码跳转/补全会指向错误位置 |
| shell 工具 | ✅ 是 | shell 工具默认 cwd 为 config 的 targetDir，clone 后自动正确 |

**Phase 1 策略**：不创建新的 geminiClient，仅依赖 Config.targetDir 切换。文件读写 / shell 工具可正常工作。LSP / watcher 在 worktree 模式下降级或关闭，后续迭代优化。

### 5.9 WorkflowAgentBridge 集成

```typescript
// WorkflowAgentRunOptions 新增字段
export interface WorkflowAgentRunOptions {
  // ... 现有字段 ...

  /** 是否为该 sub-agent 创建独立的 git worktree */
  worktree?: boolean;
  /** worktree 的可读名称 */
  worktreeName?: string;
  /** worktree 初始化命令（如 "npm install"） */
  worktreeStartCommand?: string;
}

// WorkflowAgentBridge.run() 内部
async run(options: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult> {
  let worktreeInfo: WorktreeInfo | undefined;
  let config = this.config;
  let wm: WorktreeManager | undefined;

  if (options.worktree && WorktreeManager.isGitRepo()) {
    wm = new WorktreeManager();
    worktreeInfo = await wm.create({
      name: options.worktreeName,
      startCommand: options.worktreeStartCommand,
      asyncBoot: true,  // 异步 boot，不阻塞 agent 启动
    });
    config = await this.config.cloneForWorktree(worktreeInfo.directory);
  }

  try {
    const subAgent = new SubAgent(config, ...);
    const result = await subAgent.run(options);

    // 自动提交修改（仅当有改动时）
    if (worktreeInfo && wm) {
      const cleanupResult = await wm.commitAndCleanup(
        worktreeInfo,
        `easycode: ${options.label ?? options.prompt.substring(0, 80)}`
      );
      if (cleanupResult.committed) {
        result.result += `\n\n[Worktree] 修改已提交到分支 \`${cleanupResult.branchName}\`（${cleanupResult.commitSha}）`;
      } else {
        result.result += `\n\n[Worktree] 无改动，已清理 worktree`;
      }
    }

    return result;
  } catch (error) {
    // 出错也清理 worktree（丢弃改动）
    if (worktreeInfo && wm) {
      await wm.cleanup(worktreeInfo).catch(() => {});
    }
    throw error;
  }
}
```

## 6. Workflow 脚本 API

在 workflow 脚本中通过 options 启用 worktree 模式：

```javascript
// 原有方式（共享 workspace）
await agent.run({ prompt: "修复登录 bug", max_turns: 10 });

// 新方式（独立 worktree）
await agent.run({
  prompt: "修复登录 bug",
  max_turns: 10,
  worktree: true,
  worktreeName: "fix-login-bug",
});

// 并行 worktree
const results = await agent.runParallel([
  { prompt: "添加用户 API", worktree: true, worktreeName: "feat-user-api" },
  { prompt: "添加订单 API", worktree: true, worktreeName: "feat-order-api" },
]);
```

在 WorkflowTool 层面用 `worktree_mode` 控制：

```javascript
// 启用后，所有 sub-agent 默认使用独立 worktree
export default async function(agent) {
  // 自动 worktree 隔离
  const [a, b] = await agent.runParallel([
    { prompt: "任务A" },
    { prompt: "任务B" },
  ]);
}
```

## 7. 实现计划

### Phase 1: 核心基础设施（优先级最高）

| 任务 | 文件 | 预估 |
|------|------|------|
| WorktreeManager 类（含锁/canonical/submodule） | `packages/core/src/utils/worktreeManager.ts` | ~350行 |
| Config.cloneForWorktree() | `packages/core/src/config/config.ts` | ~40行 |
| WorktreeManager 单测 | `packages/core/src/utils/__tests__/worktreeManager.test.ts` | ~200行 |

### Phase 2: Sub-Agent 集成

| 任务 | 文件 | 预估 |
|------|------|------|
| WorkflowAgentRunOptions 加 `worktree?` | `workflowAgentBridge.ts` | ~5行 |
| WorkflowAgentBridge.run() 加入 worktree 逻辑 | `workflowAgentBridge.ts` | ~40行 |
| WorkflowAgentBridge.runParallel() 适配 | `workflowAgentBridge.ts` | ~10行 |
| WorkflowToolParams 加 `worktree_mode?` | `workflow.ts` | ~5行 |

### Phase 3: 远程 Session 集成

| 任务 | 文件 | 预估 |
|------|------|------|
| remoteSession 支持 worktree | `remoteSession.ts` | ~30行 |

### Phase 4: CLI 入口

| 任务 | 文件 | 预估 |
|------|------|------|
| `--worktree` / `-w` CLI 参数 | CLI 入口文件 | ~15行 |

## 8. 风险与缓解

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| `git worktree add` 并发竞争 | 中 | Promise 队列锁 per git root（带 LRU 淘汰） |
| worktree 残留（进程 crash） | 中 | 注册 signal handler（SIGINT/SIGTERM），启动时 prune 孤儿 worktree |
| Windows fsmonitor daemon 锁定目录 | 中 | remove 前执行 `git fsmonitor--daemon stop` |
| 大仓库 worktree 创建慢 | 低 | `--no-checkout` 避免初始 checkout + `asyncBoot` 异步初始化 |
| Config 克隆遗漏状态 | 低 | 显式列出保留字段（参考 `buildIsolatedConfig`），加集成测试验证 |
| `.easycode/worktrees/` 未被 gitignore | 中 | create 前验证，自动追加到 `.gitignore` |
| submodule 状态不一致 | 中 | reset 流程包含 submodule 三重处理 |
| 含 submodule 的 worktree 清理残留 | 中 | cleanup 使用 `git clean -ffdx` + `fs.rm` maxRetries |
| 不同分支 package.json 差异 | 低 | **不 symlink node_modules**；每个 worktree 独立安装（通过 startCommand） |
| 符号链接路径误判 | 低 | 所有路径比较使用 canonical path（realPath + normalize + 小写化） |
| LSP/watcher 指向错误目录 | 低 | Phase 1 不隔离 geminiClient；LSP/watcher 在 worktree 模式下降级 |

## 9. 非目标（暂不实现）

- **自动合并回主干**：仅提交到分支，用户手动 review 后合并
- **跨 worktree 的增量同步**：每个 worktree 是完全独立的
- **worktree 间的文件锁协调**
- **UI 面板显示 worktree 状态**（后续迭代）
- **geminiClient / LSP / watcher 的 worktree 隔离**（Phase 1 仅隔离文件 cwd）
- **node_modules 共享/硬链接**（每个 worktree 独立安装，避免 phantom dependency）

## 10. 测试策略

### 单元测试（worktreeManager.test.ts）

- 创建 worktree，验证目录和分支
- 创建 worktree 时名称冲突自动重试
- slug 为空时（纯中文名）fallback 到随机 slug
- commitAndCleanup 提交修改到分支（有改动时）
- commitAndCleanup 在 pristine 状态跳过 commit（无改动时）
- cleanup 丢弃修改
- list 返回所有 worktree
- reset 恢复到指定引用（含 submodule 场景）
- isPristine 检测有无改动
- canonical path 归一化（symlink / Windows 大小写）
- 并发创建（锁机制）
- 非 git 目录拒绝创建
- 清理不存在的 worktree（幂等）
- 孤儿 worktree prune

### 集成测试

- WorkflowAgentBridge + worktree：sub-agent 在 worktree 中修改文件，主 workspace 未受影响
- 并行 worktree：多个 sub-agent 同时在不同 worktree 中工作
- Config.cloneForWorktree：验证 auth/tools/modelOverrides 在克隆后可用
- 含 submodule 的项目 reset 后状态一致

---

**文档版本**: v1.1（审核修订版）
**创建日期**: 2026-07-02
**修订日期**: 2026-07-02
**修订内容**: 对比 MiMo-Code 源码审核，修正并发锁描述、slugify 示例，补充 fsmonitor/submodule/canonical path/isPristine/asyncBoot/.gitignore 验证，修正 Config 克隆方案，移除 node_modules symlink 建议
