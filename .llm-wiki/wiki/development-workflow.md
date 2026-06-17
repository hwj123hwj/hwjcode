---
type: guide
date: 2026-06-15
tags: [workflow, git, branch, mr, development]
---

# 开发工作流规范

> 独立仓库的开发提交规范。严禁直接推 master。

## 分支命名

|前缀 |用途 |示例 |
|------|------|------|
| `feat/` |新功能 |`feat/nanobanana-toggle` |
| `fix/` |Bug修复 |`fix/version-read-error` |
| `chore/` |杂务（构建、脚本、文档） |`chore/add-sync-script` |
| `docs/` |文档/ wiki |`docs/update-repo-refs` |

## 标准流程

```bash#1.从 master拉最新git checkout master && git pull origin master#2.创建功能分支git checkout -b feat/xxx#3.开发、提交git add <files>git commit -m "feat(module): description"#4.推送分支git push -u origin feat/xxx#5.去 GitLab创建 MR，审核后合并#6.删除远程分支git push origin --delete feat/xxx#7.切回 master，拉最新git checkout master && git pull origin master#8.删除本地分支git branch -d feat/xxx```

## 提交规范

格式：`<type>(<scope>): <description>`

```
feat(feishu): add pluggable tool toggle
fix(core): resolve version read package conflict
chore(scripts): add upstream sync script
docs(wiki): update repo references
```

## ⚠️红线

- **禁止直接推 master**——所有改动必须走分支 + MR
- **禁止 `git push --force` 到 master**——master是保护分支
- **禁止 `git commit --amend`已推送的提交**
- **发版前必须验证 bundle 含最新代码**——`src/` 下的旧 `.js` 编译产物会导致 esbuild 打包旧代码，详见 [[esbuild-stale-js-bug]]

## 上游同步

上游同步走 `scripts/sync-upstream.sh`（cron 自动），不进入本工作流。

### 定时任务

```cron
# 每天中午 12:00 执行（避免凌晨休眠不触发）
0 12 * * * /Users/weijian/codex_work/DeepVcodeClient/scripts/sync-upstream.sh >> /tmp/sync-upstream.log 2>&1
```

> macOS crontab 在系统休眠时不补执行。原设凌晨 0:00 频繁漏触发，已改至中午 12:00。

### 版本号策略

- **只升不降**：取本地版本和上游 tag 的较大值（`sort -V | tail -1`）
- Fork 版本号独立领先，不受上游 tag 限制
- 详见 [[source-upstream-sync-version-strategy]] 和 [[release-process]]

### 上游同步后必须手动发版

合并上游代码后需手动升 patch 版本号并 `npm publish`，详见 [[release-process]]。

### 已知限制

- `git fetch upstream` 需要挂公司 VPN（内网 GitLab 仓库）
- 网络抖动可能导致 fetch 失败（如 -61 错误），脚本会静默继续
