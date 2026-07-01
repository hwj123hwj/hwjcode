# LLM Wiki Log

> Chronological record of wiki operations.

## [2026-06-26] update | 上游同步 + PR #4 opt-in tools + bug 修复
- Updated [[tools-system]]: 移除 PPT 工具引用，新增 OpenCliTool 和 opt-in 机制说明
- Created [[OpenCliTool]]: 浏览器自动化工具页面，含依赖、设计要点、适配器说明
- Created [[opt-in-tools]]: 按需启用机制页面，6 工具默认禁用，需 coreTools 配置
- Commit: `de8cacc4` (merge PR #4), `50fd5aaf` (fix opt-in prompt cleanup bugs)

## [2026-06-26] feat | MiMo Assistant Documentation

Added documentation for MiMo AI Assistant identity and capabilities.

### Pages Created
- `wiki/mimo-assistant.md` — MiMo-v2.5-pro identity, capabilities, working style, recent activities, and development rules

### Pages Updated
- `index.md` — Added mimo-assistant entry to Entities section

### Key Information Documented
- Identity: MiMo-v2.5-pro, 1T parameters, 1M context window, developed by Xiaomi MiMo Team
- Capabilities: Code analysis, bug detection, knowledge management, TDD, cross-platform support
- Working style: Chinese communication, file verification before editing, specific test execution
- Recent activities: OpenCliTool hint message fix (2026-06-26), commit analysis (2026-06-25)
- Development rules: TDD for CLI/Core, file verification, specific testing, knowledge base updates, git hygiene

## [2026-06-21] ingest | CLI 版本锁死 & 自定义模型压缩 token=0 & 自更新缓存问题

从对话中提取三个互相关联的 Bug：esbuild define 将根 package.json 版本烙入 bundle 导致版本号锁死、DeepVServerAdapter.countTokens 对自定义模型返回 0 导致压缩失效、self-update 外挂脚本未清除 npm cache。

### Pages Created
- `wiki/source-version-build-bugs-2026-06-21.md` — 源文档摘要：三个 Bug 的完整症状、根因链路、修复方案和版本时间线

### Pages Updated
- `wiki/context-compression.md` — 新增第4节"Token Counting for Custom Models"：countTokens 路由逻辑、自定义模型 Bug 修复说明、token 估算精度、压缩入口点表格
- `wiki/self-update.md` — 新增"Known Issues"章节：npm 缓存问题、无版本验证、login shell PATH 不一致；新增 source 交叉引用
- `wiki/build-system.md` — 新增"关键陷阱 2"警告（esbuild define 版本注入）、新增"esbuild define 与版本注入"小节（含代码示例和运行时读取优先级）、新增"npm Token 管理"和手动发布步骤、新增 source 交叉引用
- `wiki/DeepVServerAdapter.md` — 大幅扩充：更新日期和 tags、新增 Key Methods 章节（countTokens 路由逻辑、estimateTokensAsFailback 精度、cleanContents 清理逻辑）、Bug 修复交叉引用
- `wiki/esbuild-stale-js-bug.md` — Related Pages 新增 [[source-version-build-bugs-2026-06-21]] 交叉引用
- `wiki/overview.md` — 版本号从 1.1.26 更新为 1.1.41
- `index.md` — Sources 表新增 #12；修正 Entities 表中 EasyCodeServerAdapter → DeepVServerAdapter（原为死链）

### Contradictions
- `index.md` 原引用 `EasyCodeServerAdapter` 但实际文件名为 `DeepVServerAdapter.md` — 已修正
- `overview.md` 原记录 version 为 1.1.26 — 已更新为 1.1.41

## [2026-06-18] update | 收藏模型配置文件与4层匹配策略补全

用户指出每次问收藏模型都要重新查代码，wiki 里没有把配置文件结构和匹配机制记清楚。检查发现 `source-feishu-model-favorites.md` 有存储位置表格但缺4层匹配策略细节，`nl-command-dispatch.md` 有匹配算法但没引用配置文件。

### Pages Updated
- `wiki/source-feishu-model-favorites.md` — 模型配置存储机制章节扩充：新增 favoriteModels JSON 格式示例、4层匹配策略表格（精确name → 精确displayName → 拆词模糊 → 厂商别名）、厂商别名表、add 不支持简称说明
- `wiki/nl-command-dispatch.md` — 模型切换章节新增配置文件位置引用和 [[source-feishu-model-favorites]] 交叉引用

### Contradictions
- 无新增矛盾。原 wiki 内容正确但不完整，本次为补充性更新

## [2026-06-18] ingest | 上游同步版本号策略修复 & 1.1.31 发版

从对话中提取 fork 版本号独立领先策略、sync-upstream.sh 版本号对齐逻辑修复、cron 定时任务调整、1.1.31 发版流程。

### Pages Created
- `wiki/source-upstream-sync-version-strategy.md` — 源文档摘要：上游同步详情、版本号策略修复（只升不降）、cron 调整、1.1.31 发版、冲突处理
- `wiki/release-process.md` — 重建发版流程规范（原文件在上游同步中丢失）：版本号独立领先、只升不降、标准发版步骤、红线纪律

### Pages Updated
- `wiki/source-hwjcode-rename.md` — sync-upstream.sh 防护机制章节：版本号策略从"对齐上游 tag"更新为"只升不降"，新增版本号策略变更警告，新增 [[source-upstream-sync-version-strategy]] 和 [[release-process]] 交叉引用
- `wiki/development-workflow.md` — 上游同步章节扩充：新增定时任务（cron 0 12）、版本号策略、上游同步后必须手动发版、已知限制（VPN 依赖、网络抖动）
- `wiki/build-system.md` — npm Publishing 章节扩充：新增 npm 账号、版本号策略、发布流程、发版指南引用；Sources 新增 [[source-upstream-sync-version-strategy]] 和 [[release-process]]
- `wiki/self-update.md` — Related 新增 [[release-process]] 和 [[source-upstream-sync-version-strategy]] 交叉引用
- `index.md` — Sources 表新增 #11，Guides & Checklists 新增 release-process 条目

### Contradictions
- `source-hwjcode-rename.md` 原记载 sync-upstream.sh "版本号对齐到上游最新 tag" — 已过时，现为"取较大值，只升不降"策略，已修正
- `release-process.md` 在 log 中有两次记录（2026-05-29 创建、2026-06-12 更新）但文件丢失 — 原因是上游同步合并时上游删除了部分 wiki 页面，已重建
- `development-workflow.md` 上游同步章节原仅一句话 — 已补充 cron 时间、版本号策略、VPN 依赖等关键信息

## [2026-06-17] ingest | 飞书 /model favorites 子命令 & esbuild 陈旧 JS 产物 Bug

从对话中提取两个关键知识点：飞书端 `/model favorites` 子命令缺失修复，以及 esbuild 在 NodeNext 模块解析下打包 src 目录陈旧 `.js` 产物导致源码修改不生效的严重构建 Bug。

### Pages Created
- `wiki/source-feishu-model-favorites.md` — 源文档摘要：飞书 favorites 子命令修复全过程、模型配置存储机制、版本时间线、服务端数据问题
- `wiki/esbuild-stale-js-bug.md` — 概念页：esbuild NodeNext 模块解析下优先打包 src/ 下的 .js 而非 .ts 的严重 Bug，含根因、症状特征、诊断方法、修复步骤、预防措施

### Pages Updated
- `wiki/nl-command-dispatch.md` — 更新日期至 2026-06-17，新增飞书端 favorites 子命令说明（1.1.30 新增），修正 CLI vs 飞书差异描述，新增已知限制 #6（代码分叉），新增 `[[source-feishu-model-favorites]]` 交叉引用
- `wiki/build-system.md` — 新增 Pipelines 下方的 esbuild 关键陷阱警告和 `[[esbuild-stale-js-bug]]` 交叉引用，Sources 区域新增 `[[source-feishu-model-favorites]]` 和 `[[esbuild-stale-js-bug]]`
- `wiki/feishu-integration.md` — 模型切换章节新增飞书端 `/model favorites` 子命令说明（1.1.30 新增）
- `wiki/adding-builtin-tool-checklist.md` — 第12步 "Rebuild the Bundle" 新增 esbuild 陈旧 JS 产物陷阱警告和 `[[esbuild-stale-js-bug]]` 交叉引用
- `wiki/development-workflow.md` — 红线区域新增"发版前必须验证 bundle 含最新代码"条目
- `index.md` — Sources 表新增 #10，Entities/Concepts 表新增 esbuild-stale-js-bug 条目

### Contradictions
- `nl-command-dispatch.md` 原文说"飞书 `/model` handler 仅精确匹配"，暗示飞书端有 `/model <name>` 但未提及 favorites 缺失。实际飞书端 `/model` 是完全独立的实现，与 CLI 端 `modelCommand.ts` 并不共享代码。已在更新中修正。

## [2026-06-17] ingest | CLI 命名与数据存储解耦原理

从对话中提取 CLI 改名后认证和历史自动继承的原理解释，创建数据目录解耦相关的 wiki 页面。

### Pages Created
- `wiki/source-data-directory-decoupling.md` — 源文档摘要：数据存储路径与 CLI 命名完全解耦的原理，含完整数据目录映射表和旧包清理说明
- `wiki/paths.md` — 概念页：数据目录与路径体系，含目录树、关键函数表、解耦原理、legacy migration 说明

### Pages Updated
- `wiki/ProxyAuthManager.md` — 新增 Data Storage 章节（JWT 凭证路径、与 CLI 命名解耦说明）、修正 Location 为 `proxyAuth.ts`、新增 [[paths]] 交叉引用
- `wiki/SessionManager.md` — 新增 Data Storage 章节（会话目录路径链路、项目哈希隔离、与 CLI 命名解耦说明）、新增 [[paths]] 交叉引用
- `wiki/source-hwjcode-rename.md` — 在"未改动"清单中新增解耦原理引用、新增 [[paths]] 和 [[source-data-directory-decoupling]] 交叉引用
- `index.md` — 新增 source-09 和 paths 条目

### Contradictions
- `ProxyAuthManager.md` 原记录 Location 为 `core/src/auth/`，实际代码在 `core/src/core/proxyAuth.ts`，已更正

## [2026-06-17] ingest | hwjcode Rename & npm Publish

npm 包名从 `easycode-ai` 重命名为 `hwjcode`，CLI 命令从 `easycode` 改为 `hwjcode`，已发布 `hwjcode@1.1.26` 到 npmjs.org。MR #8 已合并。

### Pages Created
- `wiki/source-hwjcode-rename.md` — 重命名源文档摘要，含包名映射表、未改动清单、sync-upstream.sh 防护机制
- `wiki/self-update.md` — SelfUpdateTool 实体页，含常量、安装模式、双轨重启机制、Desktop 防护

### Pages Updated
- `wiki/overview.md` — Package name `easycode-ai` → `hwjcode`，version 更新，新增 desktop 包行
- `wiki/cli-module.md` — NPM 名 `easycode-cli` → `hwjcode-cli`，binary `easycode` → `hwjcode`，新增重命名说明
- `wiki/core-module.md` — NPM 名 `easycode-core` → `hwjcode-core`，新增重命名说明
- `wiki/build-system.md` — 新增 npm Publishing 章节（包名、安装命令、sync 保护），新增重命名说明
- `index.md` — 新增 source-08 和 self-update 条目

### Contradictions
- `overview.md` 原记录 version 为 `1.0.316`，现更正为 `1.1.26`（与上游 tag 对齐）

## [2026-06-16] ingest | NL Command Dispatch — 自然语言命令分发系统（合并更新）

从代码分析中提取自然语言命令分发系统的完整知识，合并旧页面并创建统一概念页面。

### Pages Created
- `wiki/nl-command-dispatch.md` — 三套 NL 分发机制（通用命令、模型切换、工具开关）的完整文档，含关键词映射表、6层匹配算法、CLI vs 飞书差异、已知限制和扩展指南

### Pages Deleted (merged into nl-command-dispatch)
- `wiki/nl-command-mapping.md` — 旧概念页面，内容已合并到 nl-command-dispatch.md
- `wiki/source-nl-command-mapping.md` — 旧 source summary，内容已合并到 nl-command-dispatch.md

### Pages Updated
- `wiki/feishu-integration.md` — 新增「Natural Language Command Dispatch」章节，修正 wikilink 从 `nl-command-mapping` 到 `nl-command-dispatch`
- `wiki/cli-module.md` — 新增 `useNLCommandDispatch` 和 `useNLModelSwitch` hooks 条目，新增 `[[nl-command-dispatch]]` wikilink
- `index.md` — 移除旧 source-08 和 nl-command-mapping 条目，保留 nl-command-dispatch 在 Entities 和 Features 区域

## [2026-06-05] update | feishu-integration.md & goal-driven-mode.md — 安全防护与飞书目标路由更新

更新 `.llm-wiki/wiki/feishu-integration.md` 与 `.llm-wiki/wiki/goal-driven-mode.md`：
- **安全日志截断**：新增 `safeTruncateForLog` 机制文档，说明如何通过换行符过滤和 150 字符字符限制来保证 TUI 显示整洁并防止敏感系统提示词/契约泄露。
- **飞书卡片宽度防护**：新增 `clampCodeBlock` 机制说明，说明大容量输出的双重约束（行数与字数限制）如何防止卡片渲染超限。
- **目标模式路由细节**：新增飞书信道中 `/goal` 卡片式交互流程、独立会话中延迟启动（Watchdog 和 YOLO）的核心路由原理。

## [2026-06-03] update | workflow-system.md — 魔法词门控机制文档

更新 `.llm-wiki/wiki/workflow-system.md`，新增「触发方式与魔法词门控」章节：
- 三层防御机制说明（工具描述、system prompt、per-request 硬过滤）
- `filterToolsByMessage()` 实现原理与代码位置
- 如何为其他工具添加魔法词门控的操作指南（含代码模板）

## [2026-06-02] feat | workflow-system.md — Dynamic Workflow 完整文档

新增 `.llm-wiki/wiki/workflow-system.md`，内容包括：
- 架构概览（调用链、核心文件、脚本 API）
- 超时保护链路（4层）、Agent 状态可视化、result.data 规范
- 今日修复的所有 bug 记录（上下文爆炸、脚本 JS 错误、Thinking 卡死、模型 fallback）
- Backlog：P1 Token 预算（含 Anthropic task_budget 调研结论和我们的工程实现方案）、P2 Micro Compact（详细设计）、P3 自定义 Agent 定义文件夹



### Pages Added
- `wiki/background-tasks.md` — Core background process management, CRC32 IDs, cross-platform tree termination, and shell integrations.
- `wiki/feishu-integration.md` — Secure Feishu WebSocket (WSClient) gateway, GCM credential encryption, media downloads, and SendFeishuFileTool sandboxing.
- `wiki/lark-cli-tool.md` — The `lark_cli` tool architecture, live output streams, Device-flow OAuth interception, and argument overflow guards.
- `wiki/goal-driven-mode.md` — Comprehensive guide to the `/goal` driven mode contract, idle watchdog loop, and auto-clear constraints.
- `wiki/context-compression.md` — Context compression pipeline (`CompressionService` and `MicroCompactService` triggers), role prefill safeguards, and state restorations.
- `wiki/adaptive-thinking.md` — Standardized reasoning effort mapping across OpenAI, Gemini, and Claude; Haiku exclusions, and webview BrainIcon indicators.

### Pages Updated
- `wiki/tools-system.md` — Promoted the built-in tool count from 27 to 31, introducing LarkCliTool, LocalTimeTool, GoalAchievedTool, and ImageReaderTool under the new "Workspace & Utilities" category.
- `index.md` — Registered background-tasks, feishu-integration, lark-cli-tool, goal-driven-mode, context-compression, and adaptive-thinking.

---

---

## [2026-06-12] fix | 发版流程新增 4 条禁止事项纪律

### Pages Updated
- `wiki/release-process.md` — 新增 4 条红线纪律（第4-6条）：
  - #4 Tag 必须在 master 分支上创建，禁止在 `ls-dev` 打 tag
  - #5 版本号遇到已有 tag 必须往上跳，不得跳过不打或删已有的
  - #6 严禁擅自操作远程 tag（删除/修改/覆盖）
  - 补充 CLI 和 VSCode tag 版本号对齐规则至红线部分

### Pages Updated
- `wiki/release-process.md` — 将步骤 5 中的口音错误字样“砸板”修改为规范词“发版”。

---

## [2026-05-29] feat | Release Process Guide

### Pages Added
- `wiki/release-process.md` — 详细记录了 Easy Code 项目的规范化发布流程和核心校验规则。
  - 核心限制：已推送的提交禁止 Amend 机制。
  - 核心红线：`package.json` 中的版本号必须严格低于 release tag 里的版本号，否则 CI/CD 编译发布必将失败。
  - 检索最新 Tag：使用 `git tag -l "cli-release-v*" --sort=-v:refname` 查询最新 tag 并以此计算递增下一个版本号。
  - 标准发版步骤：修改 -> 本地验证(单元测试+构建) -> Git Commit -> 检索计算新 tag -> 推送 ls-dev 分支 -> 打 tag 并推送触发 CI/CD 流程。

### Index Updated
- 在 "Guides & Checklists" 区域追加了 `release-process` 的索引，指向 `wiki/release-process.md`。

---

## [2026-05-22] feat | Built-in Tool Checklist (from local_time debugging)

### Pages Added
- `wiki/adding-builtin-tool-checklist.md` — Checklist & pitfalls for adding
  a new built-in tool to `packages/core/src/tools/`. Captures lessons from
  the `local_time` bug where the tool registered correctly but Anthropic/
  proxy parsed `functionCalls=0` from a `FUNCTION_CALL` finishReason because
  of schema/description format drift from canonical tools.

### Key Lessons Captured
- Description strings must not start with `\n` or contain em-dashes / smart
  quotes / embedded ISO-format quotes
- Constructor should not over-specify the 4 boolean flags; rely on
  [[BaseTool]] defaults like `web-search.ts` does
- `validateToolParams` must call `SchemaValidator.validate` first
- `displayName` should be a single PascalCase word
- Avoid emoji in `returnDisplay` for cross-context safety
- Always `summary` field for UI history collapse
- Bundle must be rebuilt for source changes to take effect
- Reference tools by complexity: `web-search.ts`, `read-lints.ts`,
  `local-time.ts`, `ask-user-question.ts`

### Index Updated
- Added "Guides & Checklists" section with link to the new page

---

## [2026-01-23] feat | Debate UI Enhancement Documentation

### Pages Added
- `wiki/debate-i18n-enhancement.md` — Comprehensive documentation of multilingual debate mode
  - I18n support for Chinese/English UI
  - Language selection workflow
  - Dual-language prompt phrases
  - Settings integration with `preferredLanguage`
  - Implementation details for all 9 modified files

### Index Updated
- Added "Features & Enhancements" section to `index.md`
- Listed new `debate-i18n-enhancement` page

---

## [2026-04-10] lint | Health Check

### Scan Results (32 pages)
- **Dead links:** 0 — all wikilink targets resolve to existing pages
- **Orphan pages:** 0 — all wiki files listed in index.md
- **Incomplete frontmatter:** 1 — `overview.md` used `source:` (string) instead of `sources:` (array)
- **Contradictions:** 0 — tool counts, architecture descriptions consistent across pages
- **Stale content:** 0 — all pages dated 2026-04-09, no outdated references found

### Fixes Applied
1. `wiki/overview.md` — Standardized frontmatter: `source: README.md, package.json` → `sources: [README.md, package.json]` to match convention used by all other pages

### Recommendations (not auto-fixed)
- **Missing entity pages:** Several components mentioned across multiple pages lack dedicated pages:
  - `CompressionService` — referenced in GeminiClient, source-02
  - `LoopDetectionService` — referenced in GeminiClient, source-02
  - `HookPlanner`, `HookRunner`, `HookAggregator`, `HookEventHandler` — 4 of 5 hook layers have no pages
  - `HookTranslator` — version isolation layer mentioned in source-05
- **Thin content pages:** `SkillLoader.md`, `MarketplaceManager.md`, `ProxyAuthManager.md`, `SessionManager.md` have minimal detail (~5-8 lines each)

## [2026-04-09] init | Wiki Initialized
- Created wiki directory structure
- Ready for source ingestion

## [2026-04-09] ingest | Bulk Source Generation from Codebase Analysis
- Analyzed project architecture via docs/architecture.md, package.json, README.md
- Analyzed packages/core/src/ directory structure and key classes
- Analyzed packages/cli/src/ directory structure and entry point
- Analyzed tools system: 27 built-in tools, tool patterns, execution engine
- Analyzed hooks system: 5-layer architecture, 11 event types
- Analyzed build system: esbuild, CI/CD pipelines, npm publishing
- Analyzed MCP system: transports, OAuth, two-phase loading
- Generated 7 raw source documents:
  - raw/01-architecture.md
  - raw/02-core-module.md
  - raw/03-cli-module.md
  - raw/04-tools-system.md
  - raw/05-hooks-system.md
  - raw/06-build-and-scripts.md
  - raw/07-mcp-system.md
- Updated index.md with source listing

## [2026-04-09] lint | Health Check

### Scan Results (32 pages)
- **Dead links:** 0 — all 31 unique wikilink targets resolve correctly
- **Orphan pages (filesystem):** 0 — all wiki files listed in index.md
- **Orphan pages (graph):** 1 — `overview.md` had no incoming `[[overview]]` links
- **Incomplete frontmatter:** 1 — `overview.md` missing `type` field
- **Missing cross-references:** 2 — `overview.md` (0 outgoing wikilinks), `build-system.md` (1 outgoing, missing module links)
- **Thin content:** 4 pages — `SkillLoader.md`, `MarketplaceManager.md`, `ProxyAuthManager.md`, `SessionManager.md`
- **Contradictions:** 0
- **Stale content:** Not applicable (all pages dated 2026-04-09, same-day generation)

### Fixes Applied
1. `wiki/overview.md` — Added missing `type: overview` field to frontmatter
2. `wiki/overview.md` — Added "Related Pages" section with 7 wikilinks to all major system modules; added inline wikilinks in Core Capabilities list
3. `wiki/build-system.md` — Added `[[core-module]]` and `[[cli-module]]` wikilinks in Pipelines section

### Remaining Recommendations (manual)
- Enrich thin entity pages: `SkillLoader.md`, `MarketplaceManager.md`, `ProxyAuthManager.md`, `SessionManager.md`
- Standardize or document `source` (string) vs `sources` (array) convention across page types
- Add `[[overview]]` link from at least one other page to eliminate graph orphan status
- Update individual page dates when content is modified in future edits

## [2026-04-09] ingest | Full Ingestion of All 7 Raw Sources
- Processed all 7 raw source documents into wiki pages
- Created 7 source summary pages:
  - wiki/source-01-architecture.md — Architecture, monorepo, design patterns, dependencies
  - wiki/source-02-core-module.md — Core module structure, 16 directories, key classes
  - wiki/source-03-cli-module.md — CLI module, Ink/React UI, bootstrap sequence, two modes
  - wiki/source-04-tools-system.md — 27 built-in tools, execution state machine, confirmation types
  - wiki/source-05-hooks-system.md — 5-layer pipeline, 11 event types, I/O protocol
  - wiki/source-06-build-system.md — Two build pipelines, CI/CD, TypeScript/ESLint config
  - wiki/source-07-mcp-system.md — MCP transports, two-phase loading, OAuth, tool discovery
- Created 7 system/module entity pages:
  - wiki/core-module.md, wiki/cli-module.md, wiki/tools-system.md
  - wiki/hooks-system.md, wiki/mcp-system.md, wiki/build-system.md, wiki/skills-system.md
- Created 10 class/component entity pages:
  - wiki/GeminiClient.md, wiki/ContentGenerator.md, wiki/EasyCodeServerAdapter.md
  - wiki/SceneManager.md, wiki/Turn.md, wiki/SubAgent.md
  - wiki/ToolRegistry.md, wiki/BaseTool.md, wiki/ToolExecutionEngine.md
  - wiki/DiscoveredMCPTool.md, wiki/mcp-client.md
  - wiki/HookSystem.md, wiki/HookRegistry.md
  - wiki/ProxyAuthManager.md, wiki/SessionManager.md
  - wiki/SkillLoader.md, wiki/MarketplaceManager.md
- All pages include YAML frontmatter (type, date, tags) and [[wikilink]] cross-references
- Updated index.md with full source summaries, entities, and classes
- No contradictions detected between sources
