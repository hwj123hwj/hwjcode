---
type: guide
date: 2026-06-18
tags: [release, npm, gitlab, tag, ci-cd, version, fork]
sources: [conversation-2026-06-18-upstream-sync, log-2026-05-29, log-2026-06-12]
---

# Release Process Guide

> Fork 仓库的规范化发布流程。独立于上游 CI/CD，版本号独立领先。

## 核心原则

### 1. Fork 版本号独立领先

Fork 的 npm 版本号**不受上游 tag 限制**。上游 tag 可能落后于 fork 已发布版本。

- 上游 tag `cli-release-v1.1.27` 时，fork 可能已发到 `1.1.31`
- `sync-upstream.sh` 版本号策略为**取较大值，只升不降**（详见 [[source-upstream-sync-version-strategy]]）

### 2. 版本号只升不降

```bash
# sync-upstream.sh 中的版本号对齐逻辑
TARGET=$(printf '%s\n%s\n' "$CURRENT" "$LATEST_TAG" | sort -V | tail -1)
```

禁止降版本号。如果上游 tag 低于本地版本，保持本地版本不变。

### 3. 上游同步后必须手动发版

合并上游代码后，代码已变化但版本号未升，npm 上是旧代码。必须：
1. 手动升 patch 版本号
2. 构建 + `npm publish`
3. 提交代码 + 打 tag + 推送

## 标准发版步骤

```bash
# 1. 确认在 master 分支，代码已提交
git checkout master && git status

# 2. 升版本号（4 个 package.json 统一）
node -e "
const fs = require('fs');
for (const f of ['package.json','packages/cli/package.json','packages/core/package.json','packages/desktop/package.json']) {
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  p.version = '1.1.XX';  // 替换为目标版本
  fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
}
"

# 3. 构建
npm run bundle:prod

# 4. 发布到 npm（prepublishOnly 会自动重建 bundle）
npm publish

# 5. 提交 + 打 tag + 推送
git add -A
git commit -m "chore: bump version to 1.1.XX"
git tag v1.1.XX
git push origin master
git push origin v1.1.XX
```

## npm 发布详情

| 项目 | 值 |
|------|-----|
| 包名 | `hwjcode` |
| npm 账号 | `hwj123weijian` |
| Binary | `hwjcode` → `bundle/easycode.js` |
| 安装命令 | `npm i -g hwjcode` |
| 包大小 | ~23.7 MB（含跨平台 ripgrep 二进制） |

### prepublishOnly 钩子

`npm publish` 会自动触发：
1. `scripts/prepare-publish.js` — 准备发布包
2. `cross-env BUILD_ENV=production NPM_PUBLISH_MODE=1 npm run bundle:prod` — 重建 bundle

### postpublish 钩子

`scripts/restore-after-publish.js` — 发布后清理

## ⚠️ 红线纪律

1. **Tag 必须在 master 分支上创建** — 禁止在功能分支打 tag
2. **版本号只升不降** — 禁止降版本号，`sync-upstream.sh` 已内置此逻辑
3. **禁止 `git push --force` 到 master** — master 是保护分支
4. **禁止 `git commit --amend` 已推送的提交**
5. **发版前必须验证 bundle 含最新代码** — `src/` 下的旧 `.js` 编译产物会导致 esbuild 打包旧代码（详见 [[esbuild-stale-js-bug]]）
6. **严禁擅自操作远程 tag** — 删除/修改/覆盖远程 tag 是禁止的

## 上游同步后的发版判断

上游同步合并了新代码后，**必须发版**：

| 场景 | 是否需要发版 | 原因 |
|------|-------------|------|
| 合并了上游功能提交 | ✅ 是 | npm 上旧版本不含新代码 |
| 仅合并 wiki/文档变更 | ❌ 否 | 不影响运行时 |
| 仅合并 .gitlab-ci.yml | ❌ 否 | fork 不走上游 CI |

## GitLab CI/CD（上游用，fork 不走）

上游使用 tag-based 触发：
- `cli-release-v*` → CLI 发布
- `vscode-release-v*` → VSCode 插件发布

Fork 不使用 GitLab CI 发版，直接本地 `npm publish`。

## Cross-References

- [[build-system]] — 构建管道（tsc + esbuild）
- [[source-hwjcode-rename]] — 包名重命名记录
- [[source-upstream-sync-version-strategy]] — 版本号策略修复详情
- [[development-workflow]] — 开发工作流规范
- [[esbuild-stale-js-bug]] — esbuild 陈旧 JS 产物 Bug
- [[self-update]] — 自更新工具（`/feishu restart` 热更新）
