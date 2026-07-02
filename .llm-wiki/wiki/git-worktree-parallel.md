---
type: feature
date: 2026-07-02
tags: [worktree, parallel, batch-parallel, workflow, git, isolation]
sources: [builtinWorkflows.ts, worktreeManager.ts, workflowAgentBridge.ts, config.ts]
related: [workflow-system, self-update]
---

# Git Worktree 并行工作区隔离

> 让多个 AI sub-agent 在**独立的 git worktree** 中并行开发，互不干扰。
> 适用于将一批独立需求（如 15 条 PM 改动）拆分为并行隔离任务的场景。

## 核心架构

```
batch-parallel (builtin workflow)
    │  args.tasks = [{ prompt, label? }]
    ▼
resolveBuiltinWorkflow(name, args) → 生成 JS 脚本
    │  脚本调用 agent.runParallel(tasks)
    ▼
WorkflowAgentBridge.runParallel()
    │  对每个 task 调用 run()
    ▼
run() → WorktreeManager.create() → cloneForWorktree(dir) → SubAgent.executeTask()
    │                                                   │
    │  子 agent 在 worktree 目录中工作         子 agent 结束
    ▼                                                   │
WorktreeManager.commitAndCleanup()  ◄──────────────────┘
    │  有改动 → git commit（保留分支）
    │  无改动 → cleanup（删除分支）
```

### 关键文件

| 文件 | 职责 |
|---|---|
| `packages/core/src/utils/worktreeManager.ts` | WorktreeManager：create/commit/cleanup/reset + 并发锁 |
| `packages/core/src/core/workflowAgentBridge.ts` | run() 集成 worktree 创建/降级/清理；runParallel() 无 fail-fast |
| `packages/core/src/core/builtinWorkflows.ts` | `batch-parallel` 模板，JSON.stringify 注入 tasks |
| `packages/core/src/tools/workflow.ts` | WorkflowTool：name → resolveBuiltinWorkflow → script |
| `packages/core/src/config/config.ts` | `cloneForWorktree()` 派生隔离 Config |

## batch-parallel 内置工作流

零脚本并行执行。LLM 调用 workflow 工具时传 `name: "batch-parallel"` 和
`args: { tasks: [{ prompt, label? }] }` 即可。

**生成的脚本**（由 `resolveBuiltinWorkflow` 生成，注意 `JSON.stringify` 注入安全）：

```js
const args = {"tasks":[{"prompt":"...","label":"task-1"}]}; // JSON 注入
export default async function(agent) {
  const tasks = args.tasks.map((t, i) => ({
    prompt: t.prompt,
    label: t.label || ('task-' + (i + 1)),
    worktreeName: t.name || t.label || ('task-' + (i + 1)),
    worktree: true,
    max_turns: 30,
  }));
  const results = await agent.runParallel(tasks);
  // phase 2: 汇总结果
}
```

### 安全性

`JSON.stringify(args)` 天然防止注入——序列化后的 JSON 是 JS 字面量，`</script>`、
`${}`、引号等特殊字符都会被正确转义。

## WorktreeManager 关键设计

### 并发锁（acquireLock）

- **模块级 Map**：`locks: Map<string, { count, promise }>`，key 为 gitRoot 规范化路径。
- **Promise 链式 mutex**：新请求 `await prev` 后再 `release()`，保证同一 gitRoot 的
  `git worktree add` 串行执行。
- **LRU 淘汰**：仅在 `release()` 时（`count === 0` 后）清理空闲条目，**绝不在 acquire
  阶段清理**（v1.1.64 修复，消除 count=0 窗口期竞态）。

### commitAndCleanup 数据安全原则

- commit 成功 → committed=true，保留分支，返回 commitSha。
- **有改动但 commit 失败** → `deleteBranch=false`，返回 `{ success: false, error }`。
- 无改动 → `deleteBranch=true`，删除分支。
- ⚠️ **关键**：commit 失败时绝不删除分支，保留 worktree 内容供手动恢复（v1.1.64 修复）。

### execGit 进程组 kill

- `spawn('git', args, { detached: true })` 创建独立进程组。
- 超时时 `process.kill(-child.pid, 'SIGKILL')` 杀整棵进程树，防止 git hook /
  fsmonitor daemon 子进程变孤儿（v1.1.64 修复）。
- Windows 上 `detached: true` 创建新 console 进程组，但 `process.kill(-pid)` 语义
  不同，需注意平台兼容性。

## runParallel 无 fail-fast（v1.1.64）

master 的 runParallel 曾有 fail-fast 语义（任一任务失败 → reject 整个 Promise），
在 batch-parallel 场景下是致命的：10 个任务第 1 个挂了，其余 9 个的结果全部丢失。

**修复后**：每个任务独立执行，失败转为 `{ success: false, result: error.message }`
填入结果数组。`runParallel` 永不 throw，永远返回与输入等长的结果数组。

## Config.cloneForWorktree

逐字段继承策略（与 `remoteSession.buildIsolatedConfig()` 一致），而非 spread
originalParams（后者会丢失运行时转换的状态）。

- **保留**：model, customModels, cloudModels, modelOverrides, mcpServers, coreTools,
  excludeTools, proxy, sandbox, debugMode, userRules
- **切换**：targetDir / cwd → worktree 目录
- **重新加载**：项目级记忆（DEEPV.md / AGENTS.md），使用模块级缓存的 tiktoken encoder
  避免 batch-parallel 每个worktree clone 都重新加载 ~1MB 词表

## 已知限制

1. **geminiClient 不克隆**：cloneForWorktree 返回的 Config 没有 geminiClient 实例，
   需调用方通过 SubAgent 构造时传入共享的 geminiClient。
2. **Windows 兼容性**：execGit 进程组 kill 在 Windows 上语义不同，需 `taskkill /T /F`。

## Related Pages

- [[workflow-system]] — 动态工作流系统的完整文档
- [[self-update]] — 自更新机制（fork 项目查 npm registry）
- [[release-process]] — 发版流程规范
