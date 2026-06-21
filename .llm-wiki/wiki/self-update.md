---
type: entity
date: 2026-06-21
tags: [self-update, npm, tool, feishu, restart, cache]
sources: [source-hwjcode-rename, source-version-build-bugs-2026-06-21]
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

## Known Issues

### npm 缓存导致安装旧版本

> 详见 [[source-version-build-bugs-2026-06-21]] Bug 3。

外挂脚本执行 `npm install -g hwjcode@latest` 时未清除 npm cache。npm 可能直接使用本地缓存的旧版本 tarball，导致"更新"后实际版本未变。

**当前缓解**：用户手动执行自更新前可先运行 `npm cache clean --force`。

**建议修复方向**：
- 外挂脚本在 install 前执行 `spawnSync('npm', ['cache', 'clean', '--force'])`
- 或使用 `npm install -g hwjcode@latest --prefer-online` 强制联网校验
- 安装后验证版本号

### 外挂脚本无版本验证

install 成功后仅检查 `exitCode === 0`，不验证实际安装的版本是否为目标版本。建议添加 `hwjcode --version` 验证步骤。

### Login Shell PATH 不一致

macOS 上 nvm/homebrew 安装的 Node.js 可能导致 login shell 的 `hwjcode` 路径与当前进程不同，从而运行到旧版本的二进制。

## Related

- [[feishu-integration]] — 飞书网关模式
- [[build-system]] — npm 发布流程
- [[source-hwjcode-rename]] — 包名重命名记录
- [[release-process]] — 发版流程规范
- [[source-upstream-sync-version-strategy]] — 版本号策略与最新版本
- [[source-version-build-bugs-2026-06-21]] — npm 缓存问题详情
