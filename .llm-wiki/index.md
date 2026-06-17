# LLM Wiki Index

> Auto-maintained by Easy Code. Do not edit manually.

## Sources

| # | File | Summary Page | Description | Generated |
|---|------|-------------|-------------|-----------|
| 01 | [raw/01-architecture.md](raw/01-architecture.md) | [source-01-architecture](wiki/source-01-architecture.md) | Project architecture, monorepo structure, dependencies, design patterns | 2026-04-09 |
| 02 | [raw/02-core-module.md](raw/02-core-module.md) | [source-02-core-module](wiki/source-02-core-module.md) | Core module directory layout, key classes, exports | 2026-04-09 |
| 03 | [raw/03-cli-module.md](raw/03-cli-module.md) | [source-03-cli-module](wiki/source-03-cli-module.md) | CLI module structure, entry point, components, two modes | 2026-04-09 |
| 04 | [raw/04-tools-system.md](raw/04-tools-system.md) | [source-04-tools-system](wiki/source-04-tools-system.md) | Complete tool list (27 built-in), tool patterns, execution state machine | 2026-04-09 |
| 05 | [raw/05-hooks-system.md](raw/05-hooks-system.md) | [source-05-hooks-system](wiki/source-05-hooks-system.md) | Hooks 5-layer architecture, 11 event types, configuration, I/O protocol | 2026-04-09 |
| 06 | [raw/06-build-and-scripts.md](raw/06-build-and-scripts.md) | [source-06-build-system](wiki/source-06-build-system.md) | Build pipelines, esbuild config, CI/CD, npm publishing, TypeScript/ESLint config | 2026-04-09 |
| 07 | [raw/07-mcp-system.md](raw/07-mcp-system.md) | [source-07-mcp-system](wiki/source-07-mcp-system.md) | MCP architecture, transport types, OAuth, two-phase loading, status display | 2026-04-09 |
| 08 | feat/rename-to-hwjcode (commit 2fb40e12) | [source-hwjcode-rename](wiki/source-hwjcode-rename.md) | npm 包名 easycode-ai → hwjcode, CLI 命令 easycode → hwjcode, 发布到 npmjs.org | 2026-06-17 |
| 09 | conversation-2026-06-17 | [source-data-directory-decoupling](wiki/source-data-directory-decoupling.md) | CLI 命名与数据存储解耦原理 — 所有持久化路径与包名无关 | 2026-06-17 |
| 10 | conversation-2026-06-17-feishu-model-favorites | [source-feishu-model-favorites](wiki/source-feishu-model-favorites.md) | 飞书 /model favorites 子命令新增 & esbuild 陈旧 JS 产物 Bug 修复 | 2026-06-17 |
| 11 | conversation-2026-06-18-upstream-sync | [source-upstream-sync-version-strategy](wiki/source-upstream-sync-version-strategy.md) | 上游同步版本号策略修复（只升不降）& 1.1.31 发版 & cron 时间调整 | 2026-06-18 |


## Entities

### Modules / Systems

| Page | Type | Description |
|------|------|-------------|
| [workflow-system](wiki/workflow-system.md) | entity | Dynamic Workflow — JS orchestration, multi-agent, token budget backlog |
| [core-module](wiki/core-module.md) | entity | Backend engine — API, tools, sessions, auth |
| [cli-module](wiki/cli-module.md) | entity | Terminal frontend — Ink/React UI, slash commands |
| [tools-system](wiki/tools-system.md) | entity | Extensible tool framework — 31 built-in tools |
| [hooks-system](wiki/hooks-system.md) | entity | 5-layer lifecycle hook pipeline — 11 event types |
| [mcp-system](wiki/mcp-system.md) | entity | MCP protocol integration — external tool discovery |
| [build-system](wiki/build-system.md) | entity | Two-pipeline build: tsc + esbuild |
| [skills-system](wiki/skills-system.md) | entity | Pluggable skill modules / marketplace |
| [background-tasks](wiki/background-tasks.md) | entity | Background Task system - process control & execution |
| [feishu-integration](wiki/feishu-integration.md) | entity | Feishu / Lark Bot Integration - WebSocket long-polling gateway |
| [nl-command-dispatch](wiki/nl-command-dispatch.md) | concept | Natural Language Command Dispatch — NL keyword → slash command rewrite (3 mechanisms) |
| [esbuild-stale-js-bug](wiki/esbuild-stale-js-bug.md) | concept | Critical build trap — esbuild ships stale .js artifacts from src/ instead of .ts source |

### Classes / Components

| Page | Type | Pattern | Location |
|------|------|---------|----------|
| [GeminiClient](wiki/GeminiClient.md) | entity | Facade | `core/src/core/client.ts` |
| [ContentGenerator](wiki/ContentGenerator.md) | entity | Strategy/Adapter | `core/src/core/contentGenerator.ts` |
| [EasyCodeServerAdapter](wiki/EasyCodeServerAdapter.md) | entity | Adapter | `core/src/core/` |
| [SceneManager](wiki/SceneManager.md) | entity | Strategy | `core/src/core/sceneManager.ts` |
| [Turn](wiki/Turn.md) | entity | State Machine | `core/src/core/turn.ts` |
| [SubAgent](wiki/SubAgent.md) | entity | Agent | `core/src/core/subAgent.ts` |
| [ToolRegistry](wiki/ToolRegistry.md) | entity | Registry | `core/src/tools/tool-registry.ts` |
| [BaseTool](wiki/BaseTool.md) | entity | Abstract Base | `core/src/tools/tools.ts` |
| [ToolExecutionEngine](wiki/ToolExecutionEngine.md) | entity | State Machine | `core/src/core/toolExecutionEngine.ts` |
| [DiscoveredMCPTool](wiki/DiscoveredMCPTool.md) | entity | Adapter | `core/src/tools/mcp-tool.ts` |
| [mcp-client](wiki/mcp-client.md) | entity | Module | `core/src/tools/mcp-client.ts` |
| [HookSystem](wiki/HookSystem.md) | entity | Coordinator | `core/src/hooks/hookSystem.ts` |
| [HookRegistry](wiki/HookRegistry.md) | entity | Registry | `core/src/hooks/hookRegistry.ts` |
| [ProxyAuthManager](wiki/ProxyAuthManager.md) | entity | Singleton | `core/src/core/proxyAuth.ts` |
| [SessionManager](wiki/SessionManager.md) | entity | Repository | `core/src/services/sessionManager.ts` |
| [paths](wiki/paths.md) | concept | Constants | `core/src/utils/paths.ts` |
| [SkillLoader](wiki/SkillLoader.md) | entity | Plugin | `core/src/skills/skill-loader.ts` |
| [MarketplaceManager](wiki/MarketplaceManager.md) | entity | Plugin | `core/src/skills/marketplace-manager.ts` |
| [lark-cli-tool](wiki/lark-cli-tool.md) | entity | Tool | `core/src/tools/lark-cli.ts` |
| [audio-reader](packages/core/src/tools/audio-reader.ts) | entity | Tool | `core/src/tools/audio-reader.ts` |
| [self-update](wiki/self-update.md) | entity | Tool | `core/src/tools/self-update.ts` |

## Overview

| Page | Description |
|------|-------------|
| [overview](wiki/overview.md) | Project-level overview from README.md and package.json |

## Features & Enhancements

| Page | Description |
|------|-------------|
| [debate-i18n-enhancement](wiki/debate-i18n-enhancement.md) | Debate mode i18n & language selection — multilingual UI and prompts |
| [goal-driven-mode](wiki/goal-driven-mode.md) | Goal-Driven state machine, watchdog control, contract boundaries, and goal_achieved triggers |
| [context-compression](wiki/context-compression.md) | Token-aware MicroCompactService, post-compact restoration, and prefill crash guards |
| [adaptive-thinking](wiki/adaptive-thinking.md) | Adaptive thinking effort mappings (Claude/OpenAI/Gemini), UI brain outlines, and sanitization |
| [nl-command-dispatch](wiki/nl-command-dispatch.md) | Natural Language Command Dispatch — keyword-to-slash rewrite, model switch, tool toggle |

## Guides & Checklists

| Page | Description |
|------|-------------|
| [adding-builtin-tool-checklist](wiki/adding-builtin-tool-checklist.md) | Checklist & pitfalls when adding a built-in tool to `core/src/tools/` (derived from `local_time` debugging) |
| [development-workflow](wiki/development-workflow.md) | 独立仓库开发工作流规范 —分支、MR、提交格式、红线 |
| [release-process](wiki/release-process.md) | Fork 发版流程规范 — 版本号策略、npm 发布、tag 规范、红线纪律 |

## Synthesis
<!-- Cross-cutting analysis pages will be listed here -->
