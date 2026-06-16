---
type: entity
date: 2026-04-09
tags: [build, esbuild, ci-cd, npm, typescript]
sources: [raw/06-build-and-scripts.md]
---

# Build System

> Two-pipeline build system: tsc for NPM, esbuild for bundling.

## Overview

Easy Code 使用两条构建管道：NPM 发布路径使用 `tsc` 逐包编译到 `dist/`，Bundle 路径使用 `esbuild` 打包为单一 `bundle/easycode.js` 文件。

> 2026-06-17: npm 发布包名改为 `hwjcode`，CLI 检测名单新增 `hwjcode-cli`，release.yml tgz 文件名更新。详见 [[source-hwjcode-rename]]。

## Pipelines

1. **NPM**: `tsc` → `dist/` per package ([[core-module]] → [[cli-module]] → vscode)
2. **Bundle**: `esbuild` → `bundle/easycode.js` (minified, ESM, node platform)

## npm Publishing

- **Package**: `hwjcode` on npmjs.org
- **Binary**: `hwjcode` → `bundle/easycode.js`
- **Install**: `npm i -g hwjcode`
- **Sync Protection**: [[source-hwjcode-rename|sync-upstream.sh]] 自动修复上游覆盖的包名/bin 字段

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
