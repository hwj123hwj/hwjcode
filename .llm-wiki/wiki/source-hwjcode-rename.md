---
type: source
source_path: feat/rename-to-hwjcode (commit 2fb40e12)
date: 2026-06-17
tags: [npm, rename, hwjcode, packaging, release, fork]
---

# Source: hwjcode Rename & npm Publish

## Key Takeaways

本项目（上游 fork）已将 npm 包名从 `easycode-ai` 重命名为 `hwjcode`，CLI 二进制命令从 `easycode` 改为 `hwjcode`，并成功发布到 npmjs.org。

## Important Entities & Concepts

### 包名映射

| 原名 | 新名 | 用途 |
|------|------|------|
| `easycode-ai` | `hwjcode` | npm 发布包名（root package.json） |
| `easycode-cli` | `hwjcode-cli` | CLI 子包 |
| `easycode-core` | `hwjcode-core` | Core 子包 |
| `easycode-desktop` | `hwjcode-desktop` | Desktop 子包 |
| `easycode`（bin） | `hwjcode`（bin） | 全局 CLI 命令 |

### 核心常量

- `SELF_UPDATE_PACKAGE = 'hwjcode'`（原 `'easycode-ai'`）— 自更新目标包名
- `SELF_UPDATE_RELAUNCH_COMMAND = 'hwjcode'`（原 `'easycode'`）— 重启拉起命令

### 未改动的（有意保留）

- `bundle/easycode.js` — 内部文件路径，不影响用户，改名风险大
- `.easycode-user/` — 配置目录路径，改了会破坏现有用户数据
- `EASYCODE_*` 环境变量 — 进程间通信协议
- `EasyCode` 品牌 — UI 层面，与包名/命令名无关
- `Gemini` OAuth 标识 — 必须保留，第三方 OAuth 服务只认 Gemini

## Notable Data Points

- 首个发布版本：`hwjcode@1.1.26`
- npm 账号：`hwj123weijian`
- 包大小：23.1 MB（含跨平台 ripgrep 二进制）
- 安装命令：`npm i -g hwjcode`
- CLI 命令：`hwjcode` / `hwjcode --feishu`
- MR: GitLab #8, 已合并到 master

## Modified Files (17)

- `package.json` — name, bin, version
- `packages/cli/package.json` — name, bin, version
- `packages/core/package.json` — name, version
- `packages/desktop/package.json` — name, version
- `packages/core/src/tools/self-update.ts` — 常量 + 文案
- `packages/core/src/tools/self-update.test.ts` — 测试对齐
- `packages/core/src/tools/self-update.d.ts` — 类型声明
- `packages/cli/src/ui/commands/feishuCommand.ts` — ps grep 提示、升级文案
- `packages/cli/src/ui/utils/i18n.ts` — CLI tip
- `scripts/build_package.js` — CLI 检测名单
- `scripts/sync-upstream.sh` — 新增 fork 专属字段修复
- `.github/workflows/release.yml` — tgz 文件名
- `package-lock.json` — 重建

## sync-upstream.sh 防护机制

每次上游同步后，脚本自动检查并修复：
1. root/cli/core/desktop 四个 package.json 的 `name` 字段
2. root/cli 的 `bin` 字段
3. `self-update.ts` 中的 `SELF_UPDATE_PACKAGE` 和 `SELF_UPDATE_RELAUNCH_COMMAND`
4. 版本号对齐到上游最新 tag（扩展为4个 package.json 统一对齐）

## Cross-References

- [[build-system]] — 构建和发布流程
- [[cli-module]] — CLI 模块包名变更
- [[core-module]] — Core 模块包名变更
- [[self-update]] — 自更新工具
- [[development-workflow]] — 开发工作流
