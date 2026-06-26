---
type: entity
date: 2026-06-26
tags: [tools, browser, opencli, opt-in]
sources: [packages/core/src/tools/opencli.ts]
---

# OpenCliTool

> 浏览器自动化工具 — 通过 `@jackwener/opencli` CLI 驱动用户已登录的真实 Chrome 浏览器。

## 概述

`OpenCliTool` 封装了 opencli 命令行工具，让 AI Agent 能够：
- 检查页面结构（`state`, `find`）
- 填写表单、点击按钮（`type`, `click`, `fill`）
- 提取页面数据（`extract`, `get`）
- 复用用户 Chrome 登录态（无需重新登录）

## 依赖

- 用户机器需安装 Chrome + opencli daemon + Browser Bridge 扩展
- `npm install -g @jackwener/opencli@latest`
- 安装后无需重启 easycode，工具自动检测

## Opt-in 机制

⚠️ **默认禁用**。`OpenCliTool` 属于 opt-in tools，用户必须在 `coreTools` 配置中显式添加才能使用。详见 [[opt-in-tools]]。

## 设计要点

- **适配器优先**：opencli 内置 155+ 网站适配器（github, zhihu, bilibili 等），应优先使用适配器而非手动 DOM 操作
- **读写分离**：读操作（state, find, get）直接放行；写操作（click, type）需用户确认
- **结构化错误**：`errorKind` 支持 `daemon-not-running`, `extension-not-connected`, `not-logged-in`, `stale-ref` 等分类
- **健康预检查**：首个浏览器命令前自动探测 daemon + 扩展状态
