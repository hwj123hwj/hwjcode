---
type: concept
date: 2026-06-17
tags: [paths, storage, decoupling, configuration, data-directory]
sources: [source-data-directory-decoupling]
---

# Data Directory & Path System

> 所有持久化数据的存储路径体系，基于硬编码目录常量和项目路径哈希，与 CLI 命名/npm 包名完全解耦。

## Core Constants

定义于 `packages/core/src/utils/paths.ts`：

| 常量 | 值 | 用途 |
|------|----|------|
| `GEMINI_DIR` | `'.easycode-user'` | 全局数据根 `~/.easycode-user/` |
| `PROJECT_DIR_PREFIX` | `'.easycode'` | 项目级配置前缀 `<root>/.easycode/` |

> **注意**：常量名含 "GEMINI" 是历史遗留，值已是 `.easycode-user`。此值不可更改，否则破坏所有现有用户数据。

## Directory Layout

```
~/.easycode-user/                         # 全局数据根 (GEMINI_DIR)
├── jwt-token.json                        # JWT 认证凭证 [[ProxyAuthManager]]
├── jwt-token-dev.json                    # 开发环境 JWT 凭证
├── feishu-credentials.json               # 飞书凭证
├── mcp-oauth-tokens.json                 # MCP OAuth tokens
├── skills/                               # 全局技能
├── commands/                             # 全局自定义命令
└── tmp/
    └── <SHA256(projectRoot)>/            # 项目临时数据（按项目哈希隔离）
        └── sessions/                     # 会话持久化 [[SessionManager]]
            ├── index.json
            └── <sessionId>/
                ├── metadata.json
                ├── history.json
                ├── tokens.json
                ├── context.json
                └── checkpoints.json

<projectRoot>/.easycode/                  # 项目级配置 (PROJECT_DIR_PREFIX)
├── skills/                               # 项目技能
├── commands/                             # 项目自定义命令
├── clipboard/                            # 剪贴板缓存
├── mcp-tmp/                              # MCP 临时文件
└── nanobanana/                           # 图片生成缓存
```

## Key Functions

| 函数 | 路径 | 返回值 |
|------|------|--------|
| `getProjectHash(root)` | paths.ts | `SHA256(root)` — 项目唯一标识 |
| `getProjectTempDir(root)` | paths.ts | `~/.easycode-user/tmp/<hash>` |
| `getProjectSkillsDir(root)` | paths.ts | `<root>/.easycode/skills` |
| `getProjectCommandsDir(root)` | paths.ts | `<root>/.easycode/commands` |
| `getUserCommandsDir()` | paths.ts | `~/.easycode-user/commands` |

## CLI 命名解耦原理

所有数据目录路径由以下因素决定：
1. **`os.homedir()`** — 用户家目录
2. **硬编码常量** — `.easycode-user` / `.easycode`
3. **项目根路径哈希** — `SHA256(projectRoot)`

以上三者均不涉及 CLI 二进制名或 npm 包名。因此 `easycode` → `hwjcode` 改名后，所有数据路径不变，认证和历史自动继承。

## Legacy Migration

`migrateLegacyDirectories()` 处理旧目录名迁移：
- `.deepvcode/` → `.easycode/`（项目级）
- `~/.deepv/` → `~/.easycode-user/`（用户级）
- `/etc/.deepv/` → `/etc/.easycode-global/`（全局）

仅在目标目录"无实际数据"时才执行迁移（`isDirWithoutRealData()`），避免覆盖。

## Related

- [[ProxyAuthManager]] — JWT 凭证读写
- [[SessionManager]] — 会话持久化
- [[skills-system]] — 技能目录扫描
- [[source-data-directory-decoupling]] — 解耦原理源文档
- [[source-hwjcode-rename]] — 包名重命名记录
