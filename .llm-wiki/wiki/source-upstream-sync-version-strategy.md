---
type: source
source_path: conversation-2026-06-18-upstream-sync
date: 2026-06-18
tags: [upstream-sync, version-management, npm, cron, fork, release]
---

# Source: 上游同步版本号策略修复 & 1.1.31 发版

## Key Takeaways

1. **版本号策略重大变更**：`sync-upstream.sh` 从"强制对齐上游 tag"改为"取本地版本和上游 tag 的较大值，只升不降"
2. **Fork 版本号独立领先**：fork 的 npm 版本号不受上游 tag 限制，上游 tag 1.1.27 时 fork 已发到 1.1.31
3. **macOS crontab 休眠不补执行**：定时任务从凌晨 0:00 改到中午 12:00
4. **公司内网依赖**：`git fetch upstream` 需要挂公司 VPN，非脚本 bug
5. **上游同步后必须手动发版**：合并上游代码后需手动升 patch 版本号并 `npm publish`
6. **release-process.md 丢失**：原 wiki 页面在上游同步中被删除（上游删了部分 wiki 页面），需重建

## 上游同步详情（2026-06-18）

### 上游新增内容（35 commits, 147 files, +12180/-5588）
- **Desktop 大改版**：macOS DMG 签名公证、通用二进制(arm64+x64)、i18n、Mermaid 渲染、应用内更新
- **CLI 新增命令**：chatCommand、pptCommand、docsCommand、corgiCommand、privacyCommand、loginCommand、addModelCommand
- **Core 工具变更**：新增 PPT 工具链、localAgentDetection、delegate-agent；删除 nanobanana-generate(276行)、skill-hub(442行)
- **重要 fix**：内置排除 `im:message.send_as_user` 权限；未安装本地 agent 时不注册 delegate_to_agent 工具
- 新 tag: `cli-release-v1.1.27`

### 冲突处理
- `package-lock.json` — 接受上游（`git checkout --theirs`）
- `packages/desktop/package.json` — 保留 `hwjcode-desktop` 包名 + 版本对齐

### sync-upstream.sh 版本号策略修复

**原逻辑（有 bug）**：
```bash
# 强制等于上游 tag → fork 版本号被降级
if [ "$CURRENT" != "$LATEST_TAG" ]; then
  p.version='$LATEST_TAG'
fi
```

**新逻辑（只升不降）**：
```bash
# 取本地版本和上游 tag 的较大值
TARGET=$(printf '%s\n%s\n' "$CURRENT" "$LATEST_TAG" | sort -V | tail -1)
if [ "$CURRENT" != "$TARGET" ]; then
  p.version='$TARGET'
fi
```

### 定时任务调整
- 原：`0 0 * * *`（每天凌晨 0:00）→ macOS 休眠时不触发，频繁漏执行
- 新：`0 12 * * *`（每天中午 12:00）→ 确保电脑醒着
- 6/16 那次虽触发但 `git fetch` 遇到临时网络错误（-61），因未挂 VPN

## 发版流程（1.1.31）

1. 升版本号 1.1.30 → 1.1.31（4 个 package.json）
2. `npm run bundle:prod` 构建
3. `npm publish` 发布（触发 prepublishOnly 自动重建 bundle）
4. `git commit` + `git tag v1.1.31` + `git push origin master --tags`

## Important Entities

- [[build-system]] — 构建和发布流程
- [[development-workflow]] — 开发工作流（含上游同步章节）
- [[source-hwjcode-rename]] — 包名重命名记录（含 sync-upstream.sh 防护机制）
- [[self-update]] — 自更新工具常量
- [[release-process]] — 发版流程规范

## Notable Data Points

| 项目 | 值 |
|------|-----|
| 上游 tag | cli-release-v1.1.27 |
| fork 发布版本 | hwjcode@1.1.31 |
| npm 账号 | hwj123weijian |
| cron 定时 | `0 12 * * *` |
| 上游 remote | `https://gitlab.liebaopay.com/ai_native/DeepVCode/DeepVcodeClient.git` |
| fork remote | `https://gitlab.liebaopay.com/huangweijian/DeepVcodeClient.git` |

## Contradictions Found

- [[source-hwjcode-rename]] 记载 sync-upstream.sh "版本号对齐到上游最新 tag" — 已过时，现为"只升不降"策略
- [[development-workflow]] 上游同步章节未提及版本号策略和 cron 时间 — 已补充
- `release-process.md` 在 log 中有记录但文件丢失 — 已重建
