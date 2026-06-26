---
type: concept
date: 2026-06-26
tags: [tools, opt-in, config, coreTools]
---

# Opt-in Tools 机制

> 部分工具默认禁用，需用户显式在 `coreTools` 配置中启用。

## 背景

某些工具需要外部依赖（Chrome daemon、飞书凭证、本地 Agent、API 配额），并非所有用户都需要。opt-in 机制让用户按需启用，同时从 system prompt 中移除未启用工具的指令引用，节省 token。

## Opt-in 工具列表

| Tool | 默认状态 | 启用方式 | 外部依赖 |
|------|---------|---------|---------|
| `WebSearchTool` | ❌ 禁用 | `coreTools` 配置 | Google Search API 配额 |
| `LarkCliTool` | ❌ 禁用 | `coreTools` 配置 | 飞书凭证 |
| `WorkflowTool` | ❌ 禁用 | `coreTools` 配置 | `.agent/workflows` 目录 |
| `DelegateToAgentTool` | ❌ 禁用 | `coreTools` 配置 | 本地安装 Claude Code / Codex |
| `CheckDelegateStatusTool` | ❌ 禁用 | `coreTools` 配置 | 同上 |
| `OpenCliTool` | ❌ 禁用 | `coreTools` 配置 | Chrome + opencli daemon |

## 实现

在 `Config.createToolRegistry()` 的 `registerCoreTool()` 中：
1. 检查工具是否在 `OPT_IN_TOOLS` 列表中
2. 若用户未在 `coreTools` 配置中显式列出该工具 → `isEnabled = false`
3. `prompts.ts` 中动态移除 WorkflowTool 的 system prompt 引用（`enabledToolNames` 参数）

## 用户启用方法

在项目 `.easycode/config.json` 或全局 `~/.easycode-user/config.json` 中：

```json
{
  "coreTools": ["WebSearchTool", "LarkCliTool"]
}
```

只列出需要的工具即可，未列出的 opt-in 工具保持禁用。
