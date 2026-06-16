---
type: source
source_path: "conversation-2026-06-17-data-directory-decoupling"
date: 2026-06-17
tags: [data-storage, paths, authentication, session, decoupling, cli-rename]
---

# Source: CLI 命名与数据存储解耦原理

## Key Takeaways

`hwjcode` 与 `easycode` 共享同一套数据目录，CLI 二进制改名后用户无需重新认证、对话历史完整保留。原因是**所有持久化数据的存储路径都基于硬编码的目录常量和项目路径哈希，与 CLI 命令名/npm 包名完全解耦**。

## Important Entities & Concepts

### 1. 全局数据目录常量

`packages/core/src/utils/paths.ts` 定义了两个核心常量：

| 常量 | 值 | 用途 |
|------|----|------|
| `GEMINI_DIR` | `'.easycode-user'` | 用户全局数据根目录 `~/.easycode-user/` |
| `PROJECT_DIR_PREFIX` | `'.easycode'` | 项目级配置目录前缀 `<projectRoot>/.easycode/` |

这两个常量名虽含 "Gemini"，但值已经改为 `.easycode-user` / `.easycode`，是有意保留不改的——改了会破坏所有现有用户数据。

### 2. 认证凭证存储 — [[ProxyAuthManager]]

`packages/core/src/core/proxyAuth.ts` 中 JWT token 文件路径：

```
~/.easycode-user/jwt-token.json       （生产环境）
~/.easycode-user/jwt-token-dev.json   （开发环境）
```

路径由 `os.homedir()` + 硬编码 `.easycode-user` 目录拼接，不依赖任何 CLI 名称变量。

### 3. 会话历史存储 — [[SessionManager]]

`packages/core/src/services/sessionManager.ts` 中会话目录：

```
~/.easycode-user/tmp/<SHA256(projectRoot)>/sessions/
```

关键链路：
1. `SessionManager` 构造函数调用 `getProjectTempDir(projectRoot)`
2. `getProjectTempDir` 对项目根路径做 SHA256 哈希
3. 拼接为 `~/.easycode-user/tmp/<hash>/sessions/`

**核心点**：会话目录由项目根路径的哈希决定，与 CLI 二进制名字无关。同一项目目录无论用 `easycode` 还是 `hwjcode` 打开，哈希值完全一致。

### 4. MCP OAuth Token 存储

`packages/core/src/mcp/oauth-token-storage.ts`：

```
~/.easycode-user/mcp-oauth-tokens.json
```

同样基于硬编码的 `CONFIG_DIR = '.easycode-user'`，与 CLI 命名无关。

### 5. 技能与命令目录

| 层级 | 路径 | 来源 |
|------|------|------|
| 全局技能 | `~/.easycode-user/skills/` | SkillLoader 扫描 |
| 项目技能 | `<projectRoot>/.easycode/skills/` | `getProjectSkillsDir()` |
| 全局命令 | `~/.easycode-user/commands/` | `getUserCommandsDir()` |
| 项目命令 | `<projectRoot>/.easycode/commands/` | `getProjectCommandsDir()` |

## Data Directory Map

| 数据类型 | 存储路径 | 依赖项 | CLI 改名影响 |
|---------|---------|--------|-------------|
| JWT 凭证 | `~/.easycode-user/jwt-token.json` | 硬编码路径 | 无 |
| 会话历史 | `~/.easycode-user/tmp/<hash>/sessions/` | 项目路径哈希 | 无 |
| MCP OAuth | `~/.easycode-user/mcp-oauth-tokens.json` | 硬编码路径 | 无 |
| 飞书凭证 | `~/.easycode-user/feishu-credentials.json` | 硬编码路径 | 无 |
| 用户信息 | `~/.easycode-user/` 下 | 硬编码路径 | 无 |
| 项目技能 | `<projectRoot>/.easycode/skills/` | 项目根路径 | 无 |
| 项目命令 | `<projectRoot>/.easycode/commands/` | 项目根路径 | 无 |
| 全局技能 | `~/.easycode-user/skills/` | 硬编码路径 | 无 |
| 全局命令 | `~/.easycode-user/commands/` | 硬编码路径 | 无 |

## 旧包清理

全局 `easycode-cli` / `easycode-core` 只是本地 npm link（开发用符号链接），卸载不影响任何数据。`hwjcode` npm 包已包含完整运行时。清理命令：

```bash
npm uninstall -g easycode-cli easycode-core
```

## Notable Claims

1. **目录常量不改是有意设计**：`GEMINI_DIR = '.easycode-user'` 虽然名字有历史遗留，但改值会破坏所有现有用户数据，属于不可逆操作。
2. **会话隔离粒度是项目路径**：不同项目目录产生不同哈希，会话天然隔离；同一项目无论用什么 CLI 名都映射到同一会话目录。
3. **旧包清理零风险**：全局 easycode-cli/easycode-core 只是本地 link，卸载只删二进制/符号链接，不动 `~/.easycode-user/`。

## Cross-References

- [[ProxyAuthManager]] — JWT 凭证管理
- [[SessionManager]] — 会话持久化
- [[paths]] — 路径工具函数
- [[source-hwjcode-rename]] — 包名重命名记录
- [[self-update]] — 自更新工具
- [[skills-system]] — 技能系统目录结构
- [[core-module]] — Core 模块总览
