---
type: concept
date: 2026-06-17
tags: [cli, feishu, natural-language, slash-command, model-switching, tool-toggle]
sources: [packages/cli/src/ui/hooks/useNLCommandDispatch.ts, packages/cli/src/ui/hooks/useNLModelSwitch.ts, packages/cli/src/ui/commands/feishuCommand.ts, conversation-2026-06-17-feishu-model-favorites]
---

# Natural Language Command Dispatch (自然语言命令分发)

飞书端将非斜杠的用户自然语言输入自动映射为对应 slash 命令。CLI 端仅支持模型切换映射。

## 架构

```
用户输入 (非 / 开头)
  │
  ├─ 1. NL 模型切换 (detectNLModelSwitch) → /model <name>
  ├─ 2. NL 命令分发 (detectNLCommand)     → /new /compress /wiki ingest .
  ├─ 3. NL 工具开关 (TOGGLEABLE_TOOLS)     → /tool enable/disable
  │
  └─ 均未命中 → 作为普通消息发给 AI
```

**关键文件**：
- `packages/cli/src/ui/hooks/useNLModelSwitch.ts` — `detectNLModelSwitch()`
- `packages/cli/src/ui/hooks/useNLCommandDispatch.ts` — `detectNLCommand()`
- `packages/cli/src/ui/commands/feishuCommand.ts` (L649-679, L3350-3415) — 成+工具开关
- `packages/cli/src/ui/App.tsx` (L2045-2120) — CLI端 NL 模型切换

**测试文件**：
- `packages/cli/src/ui/hooks/useNLModelSwitch.test.ts`
- `packages/cli/src/ui/hooks/useNLCommandDispatch.test.ts`

## 五类映射详情

### 1. 模型切换

**触发词**（13个）：`切换模型` `切换为` `切换到` `切到` `换成` `换为` `换到` `切换至` `换成模型` `用模型` `使用模型` `用` `换` `切`

**匹配算法**（6层优先级，按顺序执行）：
1. 检测触发词 + 提取剩余文本
2. 去噪音词（`模型` `的` `一下` `帮我` 等）
3. 精确匹配 `model.name`（不区分大小写）
4. 精确匹配 `model.displayName`
5. 关键词交集匹配（空格分词，全部命中即匹配，如 `deepseek flash` → `deepseek-v4-flash`）
6. 厂商别名：`智谱`/`zhipu`/`chatglm`→glm，`深度求索`/`ds`→deepseek，`双子星`/`谷歌`→gemini

**限制**：仅匹配用户收藏模型（`/model favorites add` 添加，最多5个）

> **配置文件**：`~/.easycode-user/settings.json` 的 `favoriteModels` 字段，存储完整模型 ID（非简称）。4层匹配策略、厂商别名表、add 不支持简称等细节详见 [[source-feishu-model-favorites]] 的「模型配置存储机制」章节。

> **重要**：飞书端 `/model favorites` 子命令于 1.1.30 版本新增。此前飞书端 `/model` 是独立实现（不与 CLI 端 `modelCommand.ts` 共享代码），只支持 `/model`（列表）和 `/model <name>`（切换），输入 `/model favorites add xxx` 会被当成模型名查找而报错。详见 [[source-feishu-model-favorites]]。

**CLI vs 飞书差异**：
- CLI：`modelCommand.ts` 有完整 favorites 子命令（add/remove/list），命中 NL 切换后直接调用 `geminiClient.switchModel()`，消息不发 AI
- 飞书：`feishuCommand.ts` 独立实现 `/model` handler，1.1.30 起新增 favorites 子命令；NL 切换改写为 `/model <name>` 走 slash 命令管线

### 2. 命令分发

| 类别 | 触发词 | 映射命令 |
|------|--------|----------|
| 新对话 | `新对话` `开个新对话` `换个话题` `清空对话` `开始新对话` `重新开始` `新建对话` `开新对话` | `/new` |
| 压缩 | `压缩上下文` `压缩对话` `压缩一下` `缩小上下文` `精简对话` `总结对话` `压缩下上下文` | `/compress` |
| 知识库 | `整理知识库` `更新知识库` `知识库摄取` `摄取文档到知识库` `知识库更新`（含错别字 `知识库集取`） | `/wiki ingest .` |

**匹配策略**：两遍扫描——先原样匹配，再去噪音词（`帮我` `给我` `一下` `现在` `请` `麻烦`）后匹配

**平台支持**：仅飞书端，CLI 端不支持

### 3. 工具开关

| 工具 | 开启 | 关闭 | 默认 |
|------|------|------|------|
| `nanobanana_generate` | `开启生图` `打开生图` `启用生图` | `关闭生图` `停用生图` `禁用生图` | opt-in（默认关闭） |
| `audio_reader` | `开启音频` `打开音频` `启用音频` | `关闭音频` `停用音频` `禁用音频` | 默认开启 |

**平台支持**：仅飞书端

定义在 `feishuCommand.ts` 的 `TOGGLEABLE_TOOLS` 常量中，持久化到 `~/.easycode-user/disabled-tools.json`。

## 设计要点

- 所有 NL 检测在**斜杠命令检测之后**、**发给 AI 之前**执行
- 飞书端改写 `messageText` 后走统一 slash 命令管线，不做直接调用
- CLI 端 NL 模型切换命中后**直接 return**，不发给 AI（与飞书端行为不同）
- 飞书 `/model` handler 仅精确匹配，但 NL 匹配做了模糊——存在潜在不一致风险

## 已知限制

1. **CLI 缺口**: 通用命令分发和工具开关仅在飞书通道生效，CLI 终端未接入
2. **命令覆盖有限**: 仅 3 个斜杠命令有 NL 映射（`/new`、`/compress`、`/wiki ingest .`），`/help`、`/stats`、`/clear`、`/goal` 等缺少
3. **无英文关键词**: 所有关键词仅中文，无英文自然语言触发
4. **工具开关精确匹配**: 不像通用命令分发支持子串匹配+噪声剥离，工具开关要求输入精确匹配触发短语
5. **潜在误触发**: `indexOf` 子串匹配可能导致长句中偶然包含关键词时误触发
6. **飞书/CLI 代码分叉**: 飞书端 `/model` 在 `feishuCommand.ts` 独立实现，CLI 端在 `modelCommand.ts`，两套代码需同步维护 favorites 等子命令。详见 [[source-feishu-model-favorites]]

## 扩展指南

- **新增 NL 命令映射**: 在 `COMMAND_MATCHERS` 数组中添加 `{ keywords: [...], slashCommand: '...' }` 条目
- **新增英文关键词**: 在 `keywords` 数组中添加英文字符串（如 `'new chat'`、`'clear conversation'`）
- **CLI 终端接入**: 在 `App.tsx` 输入提交处理器中调用 `detectNLCommand`，类似 `detectNLModelSwitch` 的集成方式
- **新增工具开关 NL 触发**: 在 `feishuCommand.ts` 的 `TOGGLEABLE_TOOLS` 中添加 `nlEnable`/`nlDisable` 数组

## Related Pages
- [[feishu-integration]]
- [[cli-module]]
- [[tools-system]]
