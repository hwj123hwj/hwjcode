---
type: entity
date: 2026-06-21
tags: [build, esbuild, ci-cd, npm, typescript, version]
sources: [raw/06-build-and-scripts.md, conversation-2026-06-17-feishu-model-favorites, source-version-build-bugs-2026-06-21]
---

# Build System

> Two-pipeline build system: tsc for NPM, esbuild for bundling.

## Overview

Easy Code 使用两条构建管道：NPM 发布路径使用 `tsc` 逐包编译到 `dist/`，Bundle 路径使用 `esbuild` 打包为单一 `bundle/easycode.js` 文件。

> 2026-06-17: npm 发布包名改为 `hwjcode`，CLI 检测名单新增 `hwjcode-cli`，release.yml tgz 文件名更新。详见 [[source-hwjcode-rename]]。

## Pipelines

1. **NPM**: `tsc` → `dist/` per package ([[core-module]] → [[cli-module]] → vscode)
2. **Bundle**: `esbuild` → `bundle/easycode.js` (minified, ESM, node platform)

> ⚠️ **关键陷阱 1**：esbuild 在 NodeNext 模块解析下，如果 `src/` 目录下存在 `.js` 编译产物，会优先打包 `.js` 而非 `.ts` 源文件，导致源码修改不生效且无报错。详见 [[esbuild-stale-js-bug]]。

> ⚠️ **关键陷阱 2**：`esbuild.config.js` 中的 `define` 配置会将 `process.env.CLI_VERSION` 在**编译时**烙入 bundle。如果 `define` 读取的是根 `package.json` 而非 `packages/cli/package.json`，版本号将被锁死。详见 [[source-version-build-bugs-2026-06-21]] Bug 1。

### esbuild define 与版本注入

`esbuild.config.js` 使用 `define` 将版本号编译时注入 bundle：

```javascript
const pkg = require('packages/cli/package.json'); // ← 必须是 CLI 包的 package.json
define: {
  'process.env.CLI_VERSION': JSON.stringify(pkg.version),
}
```

运行时 `packages/cli/src/utils/version.ts` 读取顺序：
1. `process.env.CLI_VERSION`（esbuild define 注入，编译时确定）
2. `pkgJson?.version`（`read-package-up` 运行时查找）
3. `'unknown'` fallback

**教训**：如果 define 从根 `package.json`（版本 1.1.37）读取，即使 npm 包更新到 1.1.41，运行时仍显示 1.1.37。

## npm Publishing

- **Package**: `hwjcode` on npmjs.org
- **Binary**: `hwjcode` → `bundle/easycode.js`
- **Install**: `npm i -g hwjcode`
- **npm 账号**: `hwj123weijian`
- **Sync Protection**: [[source-hwjcode-rename|sync-upstream.sh]] 自动修复上游覆盖的包名/bin 字段
- **Version Strategy**: 只升不降，取本地版本和上游 tag 的较大值（详见 [[source-upstream-sync-version-strategy]]）
- **Publish Flow**: `npm publish` 触发 `prepublishOnly`（自动重建 bundle）→ 发布 → `postpublish`（清理）
- **Release Guide**: 详见 [[release-process]]

### npm Token 管理

npm Automation token 存储在 `.secrets` 文件中（`NPM_TOKEN` 字段）。token 过期后需在 https://www.npmjs.com/settings/hwj123weijian/tokens 生成新 token。

**发布步骤**（手动路径）：
```bash
# 1. 修改版本号
cd packages/cli && npm version patch --no-git-tag-version

# 2. 重新构建 bundle（必须！否则 bundle 中版本号不会更新）
cd ../.. && cross-env BUILD_ENV=production node esbuild.config.js

# 3. 准备 dist/package.json
node scripts/prepare-publish.js

# 4. 复制 bundle 到 dist
rm -rf packages/cli/dist/bundle && mkdir -p packages/cli/dist/bundle
cp -r bundle/* packages/cli/dist/bundle/

# 5. 修正 dist/package.json（name、bin、version）
# 需要手动修改 name='hwjcode', bin={hwjcode:'./bundle/easycode.js'}

# 6. 发布
cd packages/cli/dist && npm publish --access public
```

## CI/CD

- **GitLab CI**: Tag-based triggers (`cli-release-v*`, `vscode-release-v*`)
- **GitHub Actions**: Tag push `v*.*.*` or manual dispatch → GitHub Release with `.tgz`

## Key Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Build all packages (tsc) |
| `npm run bundle:prod` | Production bundle |
| `npm run pack:prod` | Cross-platform packaging |
| `npm run preflight` | Full validation pipeline |

## Code Quality

- **TypeScript**: strict mode, es2022 target, NodeNext modules
- **ESLint**: flat config, no-explicit-any error, license header enforcement
- **Prettier**: singleQuote, semi, 80 printWidth

## Sources

- [[source-06-build-system]]
- [[source-feishu-model-favorites]]
- [[esbuild-stale-js-bug]]
- [[source-upstream-sync-version-strategy]]
- [[release-process]]
- [[source-version-build-bugs-2026-06-21]]
