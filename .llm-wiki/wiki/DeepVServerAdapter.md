---
type: entity
date: 2026-06-21
tags: [class, core, adapter, proxy-api, token-counting, custom-model]
sources: [raw/01-architecture.md, raw/02-core-module.md, source-version-build-bugs-2026-06-21]
---

# DeepVServerAdapter

> Adapter implementing [[ContentGenerator]] for the DeepV Lab proxy API. `packages/core/src/core/DeepVServerAdapter.ts`

## Overview

`DeepVServerAdapter` 将 DeepV Lab 的代理 API 适配为 [[ContentGenerator]] 接口，使 [[GeminiClient]] 能够通过代理服务器与多种 AI 模型（Gemini、Claude、自定义模型等）交互。

## Pattern

**Adapter Pattern** — 单一实现，内部路由到不同后端

## Default Server

`https://api-code.deepvlab.ai` (configured via `DEEPX_SERVER_URL` build define)

## Key Methods

### countTokens()

`ContentGenerator` 接口要求的方法，用于计算 history 的 token 数。对 [[context-compression]] 的阈值判断至关重要。

**路由逻辑**：
```
countTokens(request)
  ├─ isCustomModel(model) → estimateTokensAsFailback(request)  [客户端字符估算]
  └─ 非自定义模型 → callUnifiedTokenCountAPI()  [DeepV 代理服务端 API]
       └─ 失败 → estimateTokensAsFailback(request)  [降级]
```

> **Bug 修复 (1.1.41)**：此前自定义模型分支直接 `return { totalTokens: 0 }`，跳过了 `estimateTokensAsFailback()`，导致自动压缩和 `/compress` 对自定义模型完全失效。详见 [[source-version-build-bugs-2026-06-21]] Bug 2。

### estimateTokensAsFailback()

字符估算 fallback 方法，不依赖网络调用：
- 英文内容：~4 字符/token
- 中文内容：~2 字符/token
- 代码内容：~3 字符/token
- 工具调用：按 JSON 结构长度估算

### generateContent() / generateContentStream()

通过 `customModelAdapter.ts` 的 `callCustomModel()` / `callCustomModelStream()` 路由到具体模型适配器（OpenAI-compatible、Anthropic、Gemini native 等）。

### cleanContents()

清理 contents 数组，处理：
- 空消息/无效 parts 过滤
- 思维链（reasoning）合并到主消息
- 孤儿 functionResponse 清理（找不到配对 functionCall 的）
- 确保不以 model 消息结尾（AWS Bedrock Claude 要求 user 结尾）

## Related

- [[ContentGenerator]] — interface it implements
- [[GeminiClient]] — consumer
- [[ProxyAuthManager]] — authentication for proxy
- [[core-module]] — parent module
- [[context-compression]] — compression pipeline depends on countTokens
- [[source-version-build-bugs-2026-06-21]] — countTokens 自定义模型 Bug 修复
