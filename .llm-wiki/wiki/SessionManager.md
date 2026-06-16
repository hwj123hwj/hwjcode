---
type: entity
date: 2026-04-09
tags: [class, core, session, repository]
sources: [raw/02-core-module.md]
---

# SessionManager

> Session CRUD, cleanup, persistence, and history management.

## Overview

`SessionManager` 以 Repository 模式管理会话的创建、读取、更新、删除、清理和持久化。支持会话历史和恢复。

## Data Storage

会话存储路径与 CLI 命名完全解耦（详见 [[paths]]）：

```
~/.easycode-user/tmp/<SHA256(projectRoot)>/sessions/
```

关键链路：
1. 构造函数调用 `getProjectTempDir(projectRoot)` — 来自 [[paths]]
2. `getProjectTempDir` 对项目根路径做 SHA256 哈希
3. 拼接为 `~/.easycode-user/tmp/<hash>/sessions/`

每个会话包含：`metadata.json`, `history.json`, `tokens.json`, `context.json`, `checkpoints.json`

**核心点**：会话目录由项目路径哈希决定，与 CLI 二进制名无关。同一项目无论用 `easycode` 还是 `hwjcode` 打开，哈希值一致，共享同一会话历史。

## Pattern

**Repository Pattern**

## Location

`packages/core/src/services/sessionManager.ts`

## Related

- [[GeminiClient]] — uses SessionManager for session lifecycle
- [[core-module]]
- [[paths]] — 数据目录体系
