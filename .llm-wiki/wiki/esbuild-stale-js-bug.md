---
type: concept
date: 2026-06-17
tags: [build, esbuild, bundling, nodenext, stale-artifacts, critical-bug]
sources: [conversation-2026-06-17-feishu-model-favorites]
---

# esbuild 陈旧 JS 产物 Bug

> **严重构建陷阱**：esbuild 在 NodeNext 模块解析下，会优先打包 `src/` 目录下的 `.js` 编译产物，忽略 `.ts` 源文件，导致源码修改不生效且无任何报错。

## 根因

```
packages/cli/src/ui/commands/feishuCommand.ts   ← 源码（已修改）
packages/cli/src/ui/commands/feishuCommand.js    ← 旧编译产物（被 esbuild 打包）
```

esbuild 配置（`esbuild.config.js`）：
- 入口：`packages/cli/index.ts`
- 模块解析：NodeNext（由 `tsconfig.json` → `module: "NodeNext"` 继承）
- import 路径用 `.js` 后缀（NodeNext 规范）

NodeNext 解析 `import { X } from './feishuCommand.js'` 时：
1. 先找 `feishuCommand.js` — **如果 src 目录下有，直接命中**
2. 找不到 `.js` 才回退到 `feishuCommand.ts`

**结果**：src 下的 `.js` 编译产物比 `.ts` 源文件旧，esbuild 打包了旧代码，源码修改被完全忽略。

## 症状特征

- `npm run build` 成功（tsc 编译到 `dist/`）
- `esbuild.config.js` 执行成功（无报错）
- `npm publish` 成功
- 但发布的 bundle **不包含最新代码**
- 开发者无法从任何日志发现问题

## 诊断方法

```bash
# 用 esbuild metafile 确认实际打包了哪个文件
node -e "
const esbuild = require('esbuild');
esbuild.build({
  entryPoints: ['packages/cli/index.ts'],
  bundle: true,
  write: false,
  metafile: true,
  external: ['@vscode/ripgrep', 'sharp'],
}).then(r => {
  Object.keys(r.metafile.inputs)
    .filter(f => f.includes('feishuCommand'))
    .forEach(f => console.log(f));
});
"
# 输出 .js = 有问题，应为 .ts
```

或直接检查：

```bash
ls packages/cli/src/ui/commands/feishuCommand.js
# 如果文件存在 = 有问题
```

## 修复方法

```bash
# 1. 清理 src 下的所有编译产物
find packages/cli/src packages/core/src \
  -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" \
  | grep -v node_modules | xargs rm -f

# 2. 清理 dist 和 tsbuildinfo（避免 TS5055 "Cannot write file" 冲突）
rm -rf packages/core/dist packages/cli/dist
rm -f packages/*/tsconfig.tsbuildinfo *.tsbuildinfo

# 3. 重新构建
npm run build
npx cross-env BUILD_ENV=production node esbuild.config.js

# 4. 验证 bundle
grep -c "新代码标识符" bundle/easycode.js
```

## 为什么 src 下会有 .js 产物？

项目存在 `scripts/check-src-clean.js` 脚本（vscode-ui-plugin 使用），专门检测 src 目录下的编译产物。但 cli 和 core 包没有强制执行此检查。

`.js` 产物可能来自：
- 手动运行 `tsc` 时 `outDir` 配置不当
- IDE 自动编译
- 某些脚本意外写入

## 与 [[build-system]] 的关系

`build-system.md` 记录了两条构建管道：tsc → dist/ 和 esbuild → bundle/。但它**没有提到 esbuild 从 src 还是 dist 读取源文件**——这是本次发现的盲区。

## 预防措施

1. **CI 应增加 check-src-clean 检查**，对 cli/core 包也执行
2. **发版前验证**：发布前用 metafile 或 grep 确认 bundle 包含最新代码
3. **.gitignore**：确保 `packages/*/src/**/*.js` 被忽略（当前可能未覆盖）

## Related Pages

- [[build-system]] — 构建系统概述
- [[adding-builtin-tool-checklist]] — 已有"rebuild bundle"经验，本次扩展
- [[source-feishu-model-favorites]] — 本次 Bug 的完整上下文
- [[source-version-build-bugs-2026-06-21]] — esbuild 相关的另一个版本锁死 Bug（define 版本注入）
