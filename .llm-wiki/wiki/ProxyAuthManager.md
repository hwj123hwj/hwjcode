---
type: entity
date: 2026-04-09
tags: [class, core, auth, proxy, singleton]
sources: [raw/01-architecture.md, raw/02-core-module.md]
---

# ProxyAuthManager

> Singleton managing JWT authentication via EasyCode Lab proxy servers.

## Overview

`ProxyAuthManager` 以单例模式管理通过 EasyCode Lab 服务器的 JWT 认证。是 Easy Code 的主要认证机制（proxy-first auth）。

## Data Storage

JWT 凭证存储于硬编码路径，与 CLI 命名完全解耦（详见 [[paths]]）：

| 文件 | 路径 | 环境 |
|------|------|------|
| `jwt-token.json` | `~/.easycode-user/jwt-token.json` | 生产 |
| `jwt-token-dev.json` | `~/.easycode-user/jwt-token-dev.json` | 开发 |

路径由 `os.homedir()` + `'.easycode-user'` 拼接，不依赖 CLI 二进制名。因此 `easycode` → `hwjcode` 改名后认证自动继承，无需重新登录。

## Pattern

**Singleton**

## Location

`packages/core/src/core/proxyAuth.ts`

## Related

- [[EasyCodeServerAdapter]] — uses ProxyAuthManager for API auth
- [[core-module]]
- [[paths]] — 数据目录体系
