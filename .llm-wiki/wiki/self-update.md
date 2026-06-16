---
type: entity
date: 2026-06-17
tags: [self-update, npm, tool, feishu, restart]
sources: [source-hwjcode-rename]
---

# SelfUpdateTool

> `packages/core/src/tools/self-update.ts` — 飞书常驻模式下的自更新/重启工具。

## Overview

SelfUpdateTool 仅在飞书网关模式下动态注册，支持从 npm 安装最新版并重启、安装本地 tgz 并重启、或仅重启（救卡死/应用新配置）。

## Key Constants

| 常量 | 值 | 用途 |
|------|----|------|
| `SELF_UPDATE_PACKAGE` | `'hwjcode'` | npm 安装目标包名 |
| `SELF_UPDATE_RELAUNCH_COMMAND` | `'hwjcode'` | 重启拉起的全局命令名 |
| `SELF_UPDATE_RELAUNCH_ARGS` | `['--feishu']` | 重启参数 |

> **注意**: 2026-06-17 从 `easycode-ai`/`easycode` 改为 `hwjcode`/`hwjcode`。

## Install Modes

| Mode | install 字段 | 行为 |
|------|-------------|------|
| `none` | `{ type: 'none' }` | 仅重启，不安装（/feishu restart 热重启） |
| `npm` | `{ type: 'npm', packageName: 'hwjcode' }` | `npm install -g hwjcode@latest` |
| `tgz` | `{ type: 'tgz', path: '/abs/pkg.tgz' }` | `npm install -g /abs/pkg.tgz` |

## Relaunch Mechanism

1. 生成跨平台"外挂"脚本（纯 JS）写入 `$TMPDIR/hwjcode-relaunch-{pid}-{ts}.js`
2. detached spawn 外挂脚本
3. 当前进程延迟 1.5s 后优雅退出（执行 `onBeforeRestart` 回调）
4. 外挂轮询父 PID 消失 → 安装 → login shell 拉起新进程 → 自删

### Dual Launch Strategy

- **Windows**: `cmd.exe /c hwjcode --feishu`（有 conpty）
- **Linux/macOS**: login shell `-l -c hwjcode --feishu`（加载 .bashrc/.profile，确保 nvm/homebrew PATH 生效）

## Desktop Guard

当 `EASYCODE_DESKTOP_MANAGED=1` 时直接短路返回不支持——桌面版由 Electron 管理生命周期。

## Tool Schema

- action: `update_and_restart` | `restart_only`
- source: `npm` | `local`
- sourcePath: 本地 .tgz 绝对路径（source=local 时必须）
- reason: 日志备注

## Related

- [[feishu-integration]] — 飞书网关模式
- [[build-system]] — npm 发布流程
- [[source-hwjcode-rename]] — 包名重命名记录
