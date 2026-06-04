---
type: entity
date: 2026-04-09
tags: [class, core, auth, proxy, singleton]
sources: [raw/01-architecture.md, raw/02-core-module.md]
---

# ProxyAuthManager

> Singleton managing JWT authentication via DeepV Lab proxy servers.

## Overview

`ProxyAuthManager` 以单例模式管理通过 DeepV Lab 服务器的 JWT 认证。是 DeepV Code 的主要认证机制（proxy-first auth）。

## Pattern

**Singleton**

## Location

`packages/core/src/auth/`

## Related

- [[DeepVServerAdapter]] — uses ProxyAuthManager for API auth
- [[core-module]]
