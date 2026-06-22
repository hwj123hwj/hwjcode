/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书网关下的「认证失效」识别与友好提示。
 *
 * 背景：JWT 登录状态失效时，后端返回 `UnauthorizedError('Authentication required
 * - please re-authenticate')`，沿 stream 一路冒泡到 feishuCommand 的 catch 块。
 * 之前直接把原始 `err.message` 拼进飞书消息，用户在飞书里只会看到一句看不懂的
 * 英文「处理消息时出错: Authentication required - please re-authenticate」。
 *
 * 此模块提供：
 *   1) `isFeishuAuthError`：双重识别（类型 / name / 消息字符串），稳健应对 bundle 后
 *      跨包 `instanceof` 失效的情况；
 *   2) `buildFeishuAuthErrorMessage`：把任何认证失效错误统一替换为中文友好提示，
 *      引导用户去 easycode 终端执行 `/auth` 重新登录。
 *
 * 纯函数、无运行时依赖，便于单测。
 */

import { UnauthorizedError } from 'deepv-code-core';

/** 飞书认证失效时展示给用户的引导文案（核心提示，单独导出便于断言/复用）。 */
export const FEISHU_AUTH_ERROR_HINT =
  '请到 easycode 终端内输入 /auth 重新登录后继续。';

/**
 * 认证失效错误消息特征。任一命中即判定为认证失效：
 * - `authentication required`：后端 `UnauthorizedError` 的标准 message；
 * - `please re-authenticate`：同上的后半句，单独匹配以兼容措辞变体。
 *
 * 注意：故意不匹配裸 `auth` / `authorization`，避免把 "author"、
 * "authorization header" 之类无关文案误判为认证失效。
 */
const AUTH_ERROR_MESSAGE_PATTERNS = [
  'authentication required',
  'please re-authenticate',
];

/**
 * 从任意错误对象中提取可用于匹配的小写消息文本。
 */
function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message ?? '';
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

/**
 * 判断一个错误是否属于「JWT/登录认证失效」。
 *
 * 双重识别（满足其一即为 true）：
 *   1) `err instanceof UnauthorizedError`（同包内最可靠）；
 *   2) `err.name === 'UnauthorizedError'`（bundle 后跨包 instanceof 可能失效，
 *      退化为按类名识别）；
 *   3) 错误消息命中认证失效特征串（兜底，覆盖各种传播路径与字符串错误）。
 */
export function isFeishuAuthError(err: unknown): boolean {
  if (err == null) return false;

  // 1) 类型判定
  if (err instanceof UnauthorizedError) return true;

  // 2) 类名判定（跨 bundle 安全）
  if (
    err instanceof Error &&
    err.name === 'UnauthorizedError'
  ) {
    return true;
  }

  // 3) 消息字符串判定
  const msg = extractMessage(err).toLowerCase();
  if (!msg) return false;
  return AUTH_ERROR_MESSAGE_PATTERNS.some((p) => msg.includes(p));
}

/**
 * 构造飞书端展示的认证失效友好提示，替换掉看不懂的原始英文错误。
 *
 * @param _rawMessage 原始错误消息（当前不回显给用户，仅保留入参以便将来调试/记录）。
 */
export function buildFeishuAuthErrorMessage(_rawMessage?: string): string {
  return `登录状态失效，${FEISHU_AUTH_ERROR_HINT}`;
}
