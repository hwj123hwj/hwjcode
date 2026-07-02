---
type: concept
date: 2026-07-02
tags: [self-update, npm-registry, fork, version-check, force-update]
sources: [updateCheck.ts, gemini.tsx, i18n.ts, self-update.ts]
related: [self-update, release-process]
---

# Fork 更新检查机制（npm registry）

> Fork 项目（hwjcode）的更新检查直接查询 npm registry，而非公司后端
> `api-code.deepvlab.ai`。因为公司后端返回的是公司产品版本号（如 1.1.1），
> 与 fork 的 npm 版本号不一致，会导致强制更新永远不触发。

## 背景

hwjcode 是公司 CLI（deepv-code）的独立 fork，npm 包名不同。原来
`checkForUpdates()` 调用公司后端 API：

```
GET https://api-code.deepvlab.ai/api/update-check?version=1.1.61
→ {"latestVersion":"1.1.1", "forceUpdate":false}  // 公司产品版本，跟 fork 对不上
```

导致 fork 实例即使 npm 上已有 1.1.62，也永远不会收到更新提示。

## 修复方案（v1.1.63）

### 数据源切换

`packages/cli/src/ui/utils/updateCheck.ts` 直接查 npm registry：

```ts
const npmRegistryUrl = `https://registry.npmjs.org/${packageName}/latest`;
const response = await fetch(npmRegistryUrl, { ... });
const npmData = await response.json();
const latestVersion = npmData.version;
```

### 强制更新策略

Fork 项目所有 npm 更新都视为强制更新（`forceUpdate = true`），确保运行实例
始终最新：

```ts
if (hasRealUpdate) {
  result = `FORCE_UPDATE:${latestVersion}:${updateCommand}${MESSAGE_SEPARATOR}...`;
}
```

## 自我 DoS 防护（v1.1.65 → v1.1.66 迭代）

### 问题

v1.1.63 引入 `forceUpdate=true` 后，存在一个自我 DoS 陷阱：

1. 启动 → 检测到新版本 → 写缓存 `lastResult = "FORCE_UPDATE:..."`
2. 执行 `executeUpdateCommand` → 假设失败（网络/权限）→ `process.exit(1)` 退出
3. 24h 内再次启动 → 读缓存返回 FORCE_UPDATE → 再次失败 → 再次退出
4. **结果：24h 内 CLI 完全无法启动**

### v1.1.65 初版修复（不缓存 FORCE_UPDATE）

- 缓存保护：`if (!forceCheck && result === null)` — 只有"无更新"才缓存。
- 降级启动：更新失败不再 `process.exit(1)`。

**问题**：有更新时每次启动都打 npm registry 请求（失去缓存节流）。

### v1.1.66 最终修复（failCount 策略）

双重防护，兼顾安全和性能：

1. **缓存 + failCount**（`updateCheck.ts`）：FORCE_UPDATE 结果正常缓存（节流），
   但增加 `failCount` 字段。`failCount >= 3` 时降级为 null（跳过强制更新）：

   ```ts
   if (cache.failCount && cache.failCount >= 3 && cache.lastResult?.startsWith('FORCE_UPDATE:')) {
     return null; // 降级：跳过强制更新，让 CLI 正常启动
   }
   ```

2. **失败时递增 failCount**（`gemini.tsx`）：`executeUpdateCommand` 失败后写回缓存
   递增 failCount。成功更新后 failCount 自然重置（因为 `cache.version` 变了）。

3. **降级启动**（`gemini.tsx`）：更新失败不再 `process.exit(1)`，改为软提示后继续启动。

### failCount 重置规则（v1.1.67 修正）

v1.1.66 的 failCount 写入逻辑有一个缺陷：failCount 永远不会被正确重置。
当用户成功更新后，如果新版本恰好又有另一个更新，failCount 仍然保留上次累积的值。

**修正后**（v1.1.67）：failCount 重置规则明确化：
- `result === null`（无更新）→ failCount 重置为 0
- 目标版本变化（`newKey !== oldKey`）→ failCount 重置为 0
- 同一目标版本（`newKey === oldKey`）→ 保留旧 failCount（gemini.tsx 在失败时递增）

```ts
const failCount = (result && newKey === oldKey) ? (oldCache?.failCount ?? 0) : 0;
```

## 相关文件

| 文件 | 修改内容 |
|---|---|
| `packages/cli/src/ui/utils/updateCheck.ts` | npm registry 查询 + 缓存保护 |
| `packages/cli/src/gemini.tsx` | 更新失败降级启动 |
| `packages/cli/src/ui/utils/i18n.ts` | 新增 `update.failed.fallback.continue` 文案 |

## Related Pages

- [[self-update]] — SelfUpdateTool 实体页
- [[release-process]] — 发版流程规范
- [[git-worktree-parallel]] — worktree 并行工作区
