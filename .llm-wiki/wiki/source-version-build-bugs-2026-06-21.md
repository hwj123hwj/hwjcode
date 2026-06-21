---
type: source
source_path: conversation-2026-06-21
date: 2026-06-21
tags: [build, esbuild, version, compression, custom-model, self-update, npm, bug-fix]
---

# Source: Version & Compression Bugs (2026-06-21)

> 从对话中提取三个互相关联的 Bug 及其根因修复。

## Key Takeaways

1. **CLI 版本号锁死在 1.1.37** — `esbuild.config.js` 从仓库根目录的 `package.json` 读取 `pkg.version`，通过 `define` 烙入 bundle 为 `process.env.CLI_VERSION`。运行时 `version.ts` 优先读取 `env.CLI_VERSION`，导致 npm 发新版后版本号仍显示旧值。
2. **自定义模型压缩显示 0 token** — `DeepVServerAdapter.countTokens()` 对自定义模型直接 `return { totalTokens: 0 }` 跳过了已有的字符估算方法，导致自动压缩永不触发、`/compress` 显示原始/压缩后 token 均为 0。
3. **自更新 npm 缓存问题** — `self-update.ts` 外挂脚本执行 `npm install -g hwjcode@latest` 时未清除 npm cache，可能安装到缓存的旧版本 tarball。

## Entities & Concepts

- [[build-system]] — esbuild define 配置与版本注入
- [[context-compression]] — 压缩服务对自定义模型的 token 计数路径
- [[self-update]] — 外挂脚本的 npm 安装流程
- [[EasyCodeServerAdapter]] — `countTokens` 方法的自定义模型分支

## Bug 1: CLI Version Stuck at 1.1.37

### Symptoms
- `hwjcode --version` 显示 `1.1.37`，即使已安装 `hwjcode@1.1.40`
- npm registry 和 `npm list -g` 确认是 1.1.40，但运行时显示旧版本
- 自更新后仍显示旧版本号

### Root Cause Chain
```
esbuild.config.js: const pkg = require('package.json')  ← 读根目录 version=1.1.37
  ↓
define: { 'process.env.CLI_VERSION': JSON.stringify(pkg.version) }
  ↓
bundle/easycode.js: const CLI_VERSION = "1.1.37"  ← 编译时硬编码
  ↓
version.ts: return process.env.CLI_VERSION || pkgJson?.version  ← env 优先
  ↓
runtime: 永远返回 1.1.37
```

### Additional Factor
- `read-package-up` 的 `readPackageUp()` 从 bundle 目录向上查找 `package.json`，在 `bundle/package.json`（`{"type":"module"}`，无 version 字段）处找到但 version 为空
- 即使 `env.CLI_VERSION` 未设置，`pkgJson?.version` 也可能是 undefined
- 结果 fallback 到 `'unknown'` 或被 esbuild define 覆盖

### Fix
- `esbuild.config.js` 改为 `require('packages/cli/package.json')` — 从 CLI 包读版本
- 发版到 `hwjcode@1.1.41`

### Prevention
- 每次 `npm version patch` 后必须重新 `npm run bundle:prod`
- CI/CD 应在 bundle 后验证 `grep -o '1\.1\.[0-9]*' bundle/easycode.js | sort -u` 确认版本正确

## Bug 2: Custom Model Compression Token Count = 0

### Symptoms
- 自定义模型用户调用 `/compress` 显示 `📦 原始 token: 0 / 📦 压缩后 token: 0`
- 自定义模型用户的自动压缩永不触发（0 < threshold 永远为 true）

### Root Cause
`DeepVServerAdapter.countTokens()` (line ~2068):
```typescript
if (isCustomModel(modelToUse)) {
  console.log('[DeepV Server] Custom model detected, token counting not supported');
  return { totalTokens: 0 };  // ← 硬编码返回 0
}
```

已有 `estimateTokensAsFailback()` 方法（基于字符估算：英文 ~4字符/token，中文 ~2字符/token，代码 ~3字符/token），但自定义模型在 early return 分支被跳过。

### Impact
- [[context-compression]] 对自定义模型完全失效
- MCP response guard 的大小检查也受影响

### Fix
改为调用已有的估算方法：
```typescript
if (isCustomModel(modelToUse)) {
  return this.estimateTokensAsFailback(request);
}
```

## Bug 3: Self-Update npm Cache Serving Stale Tarballs

### Symptoms
- 自更新后版本号未变（可能仍显示旧版本）
- 根因：npm 本地缓存的 tarball 未清除

### Root Cause
`self-update.ts` 外挂脚本 (line ~147):
```javascript
const install = spawnSync('npm', ['install', '-g', 'hwjcode@latest'], { ... });
// 无 --prefer-online、无 npm cache clean
```

### Recommendation
- 安装前执行 `npm cache clean --force`
- 或使用 `npm install -g hwjcode@latest --prefer-online`
- 安装后验证版本：`hwjcode --version`

## Version Timeline

| Version | Change |
|---------|--------|
| 1.1.37 | 基线版本（根 package.json 锁死） |
| 1.1.38 | 尝试修复（bundle 未正确打包） |
| 1.1.39 | 尝试修复（bundle 未正确打包） |
| 1.1.40 | 包含自定义模型 countTokens 修复，但 bundle 版本仍为 1.1.37 |
| 1.1.41 | 正式修复 esbuild 版本注入问题 |

## Cross-References

- [[build-system]] — esbuild define 版本注入配置
- [[context-compression]] — 自定义模型 token 计数路径
- [[self-update]] — 外挂脚本 npm 安装流程
- [[EasyCodeServerAdapter]] — countTokens 方法
- [[esbuild-stale-js-bug]] — esbuild 相关的另一个已知 Bug
