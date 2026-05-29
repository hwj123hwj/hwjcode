---
type: guide
date: 2026-05-29
tags: [release, git, tag, ci-cd, npm, workflow]
---

# Release Process Guide

> 本文档详细记录了 DeepV Code 项目的规范化发布流程和核心校验规则。

## 核心规则与纪律

在执行任何发布动作之前，必须严格遵守以下关键准则，否则会导致 CI/CD 编译失败或污染代码分支：

### 1. 已推送的提交禁止 Amend
- **常驻开发分支**：`ls-dev` 分支会频繁合到主线。
- **Git 提交纪律**：**已推送到远程仓库的提交绝对不能再进行 `git commit --amend`**！如果需要修改，必须新建一笔 commit。提 MR 时也绝对不要加 `--remove-source-branch`。

### 2. 版本号严格关系限制 (CI 成功前提)
- `package.json` 中的版本号可以不随发布手动递增（CI 发布时会自动注入真实版本号）。
- ⚠️ **核心红线限制**：**`package.json` 里的版本号必须严格低于（<）发布的 release tag 版本号**。
  - *示例*：如果 release tag 为 `cli-release-v1.0.358`，则 `package.json` 的版本必须小于 `1.0.358`（例如项目内维持在 `1.0.319` 便能完美通过 CI）。

---

## 规范发布步骤

请严格按照以下标准化顺序执行代码修改和版本发布：

### 步骤 1. 代码修改与就地验证
在修改完业务代码后，严禁直接推送。必须执行以下验证：
- **运行单元测试**：使用单文件测试命令来节省资源。
  ```bash
  npx vitest run <test-file-path>
  # 示例：
  npx vitest run packages/core/src/tools/shell.test.ts
  ```
- **完整构建编译**：确保 TypeScript 编译器类型校验没有引入任何错误。
  ```bash
  npm run build
  ```

### 步骤 2. 本地代码提交
将修改提交至 `git`：
```bash
git add <modified-files>
git commit -m "feat(module): your clear message"
```

### 步骤 3. 获取最新 Release Tag 并计算下一版
列出远程最新的 release tag 列表：
```bash
git tag -l "cli-release-v*" --sort=-v:refname
```
- *假设*：当前列出的最新 tag 是 `cli-release-v1.0.357`。
- *计算*：下一个 tag 应该向上递增，即为 `cli-release-v1.0.358`。
- 确认本地 `package.json` 中的版本号小于此版本。

### 步骤 4. 推送代码与 Tag
1. 首先将本地分支推送至远程：
   ```bash
   git push origin ls-dev
   ```
2. 本地创建递增后的新 Tag：
   ```bash
   git tag cli-release-v1.0.358
   ```
3. 将此 Tag 单独推送到远程，触发 CI/CD 自动化流水线：
   ```bash
   git push origin cli-release-v1.0.358
   ```

---

## 关联阅读

- [[build-system]]
- [[cli-module]]
- [[core-module]]
