---
type: source
source_path: conversation-2026-06-17-feishu-model-favorites
date: 2026-06-17
tags: [feishu, model-switching, favorites, esbuild, build-bug, glm, npm-publish]
---

# Source: Feishu /model favorites 子命令 & esbuild 陈旧 JS 产物 Bug

## 概述

本次对话围绕两个问题展开：
1. 飞书端 `/model favorites add/remove/list` 子命令缺失
2. 代码修复后发版，bundle 中仍无新代码（esbuild 打包了 src 目录下的陈旧 `.js` 编译产物）

最终发布 `hwjcode@1.1.30`，修复两个问题。

## 关键发现

### 1. 飞书端 `/model` 命令缺失 favorites 子命令

- **CLI 端** `modelCommand.ts` 有完整的 `favorites` 子命令（add/remove/list）
- **飞书端** `feishuCommand.ts` 的 `case '/model'` 是独立实现，只支持 `/model`（列表）和 `/model <name>`（切换）
- 输入 `/model favorites add glm-5.2` 时，`favorites` 被当成模型名查找，报 "未能找到模型"
- **修复**：在 `feishuCommand.ts` 的 `case '/model'` 开头增加 `parts[1]?.toLowerCase() === 'favorites'` 判断

### 2. esbuild 陈旧 JS 产物 Bug（严重）

这是本次最关键的发现。根因链条：

1. `packages/cli/src/` 目录下存在旧的编译产物 `feishuCommand.js`（6月17日01:30生成）
2. esbuild 配置入口为 `packages/cli/index.ts`，模块解析模式为 NodeNext
3. NodeNext 模式下，import 路径 `./feishuCommand.js` 优先匹配到 src 目录下的 `.js` 文件，而非 `.ts` 源文件
4. esbuild 打包了旧的 `.js`，源码修改完全被忽略
5. 发布到 npm 的 bundle 不含新代码，但开发者看不到任何错误

**验证方法**：
```bash
# 用 esbuild metafile 确认实际打包了哪个文件
node -e "esbuild.build({entryPoints:['packages/cli/index.ts'],bundle:true,write:false,metafile:true}).then(r=>{Object.keys(r.metafile.inputs).filter(f=>f.includes('feishuCommand')).forEach(f=>console.log(f))})"
# 输出 feishuCommand.js 而非 feishuCommand.ts = 有问题
```

**修复方法**：
```bash
# 清理 src 下的所有编译产物
find packages/cli/src packages/core/src -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" | grep -v node_modules | xargs rm -f
# 清理 dist 和 tsbuildinfo（避免 TS5055 冲突）
rm -rf packages/core/dist packages/cli/dist packages/*/tsconfig.tsbuildinfo *.tsbuildinfo
# 重新构建
npm run build
npx cross-env BUILD_ENV=production node esbuild.config.js
```

### 3. 模型配置存储机制

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `cloudModels` | `~/.easycode-user/settings.json` | 服务端 `/web-api/models` 下发的缓存，含 name/displayName/creditsPerRequest/maxToken |
| `favoriteModels` | `~/.easycode-user/settings.json` | 用户收藏列表，存**完整模型 ID**（如 `deepseek-v4-pro`），最多5个 |
| `preferredModel` | `~/.easycode-user/settings.json` | 偏好模型 |

#### favoriteModels 存储格式

```json
"favoriteModels": [
  "glm-5.2",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "claude-sonnet-4-6"
]
```

存的是**完整模型 ID**（即 `cloudModels[].name`），不是简称。

#### NL 切换的 4 层匹配策略（`matchModelName`）

用户说简称能切换，是因为 NL 匹配有4层策略（代码：`useNLTriggerRegistry.ts:245`）：

| 层级 | 逻辑 | 示例 |
|------|------|------|
| 1 | 精确匹配 model name（不区分大小写） | `deepseek-v4-pro` → 命中 |
| 2 | 精确匹配 displayName | `DeepSeek-V4-Pro` → 命中 |
| 3 | **拆词模糊匹配**：查询词按空格拆分，所有关键词都出现在 name 或 displayName 中即命中 | 说 `deepseek pro` → 拆成 `deepseek`+`pro`，`deepseek-v4-pro` 包含两者 → 命中 |
| 4 | 厂商别名：映射到前缀，匹配第一个该前缀的收藏模型 | 说 `深度求索` → 映射 `deepseek` 前缀 → 命中第一个 `deepseek-*` |

**厂商别名表**：

| 别名 | 映射前缀 |
|------|----------|
| `智谱` / `zhipu` / `chatglm` | `glm` |
| `深度求索` / `ds` | `deepseek` |
| `双子星` / `谷歌` | `gemini` |

#### /model favorites add 的匹配方式

`add` 子命令支持填 **displayName 或 name**，通过 `getModelNameFromDisplayName` 解析成完整 ID 存入。但**不支持简称**——add 走精确匹配，不走4层模糊。

### 4. 服务端数据问题

`cloudModels` 中曾出现两条 `name: "glm-5.2"` 记录（displayName 分别为 "GLM-5.1" 和 "GLM-5.2"），导致按 name 匹配时可能命中错误记录。这是服务端数据问题，需服务端修复。

## 重要实体与概念

- [[feishu-integration]] — 飞书集成，包含 `/model` 命令处理
- [[nl-command-dispatch]] — 自然语言命令分发，模型切换依赖 favorites
- [[build-system]] — 构建系统，esbuild 打包配置
- [[esbuild-stale-js-bug]] — 本次发现的关键构建陷阱
- [[adding-builtin-tool-checklist]] — 已有的"rebuild bundle"经验，本次扩展

## 版本时间线

| 版本 | 内容 |
|------|------|
| 1.1.27 | 已发布（不含 favorites 修复） |
| 1.1.28 | 添加 favorites 子命令，但 bundle 含旧代码（esbuild bug） |
| 1.1.29 | 上游同步产生，仍含旧代码 |
| 1.1.30 | 清理 src 下的 .js 产物后重新打包，favorites 正式生效 |

## Contradictions

- `nl-command-dispatch.md` 原文说飞书 `/model` handler "仅精确匹配"，暗示飞书端有 `/model <name>` 但未提及 favorites 缺失。实际飞书端 `/model` 是完全独立的实现，与 CLI 端 `modelCommand.ts` 并不共享代码。
