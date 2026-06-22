/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 猎豹集团（cmcm.com）员工的飞书 setup 专属提示。
 *
 * 需求：当当前登录用户的邮箱属于猎豹集团（@cmcm.com）时，在 `/feishu setup` 输出里
 * 额外高亮一行，引导其访问组织内部的「飞书 Agent 快速创建指南」wiki。
 *
 * 纯函数、无运行时依赖，便于单测。
 */

/** 猎豹集团内部「飞书 Agent 快速创建指南」wiki 链接。 */
export const CHEETAH_WIKI_URL =
  'https://cheetah-mobile.feishu.cn/wiki/H8t6wbOEpiQ0QHk2pn5czsBvnXK';

/** 猎豹集团企业邮箱域名。 */
const CHEETAH_EMAIL_DOMAIN = 'cmcm.com';

// ANSI 颜色常量（与 nanoBananaCommand / mcpCommand 一致的手写风格）。
const COLOR_YELLOW = '\u001b[33m';
const BOLD = '\u001b[1m';
const RESET_COLOR = '\u001b[0m';

/**
 * 判断邮箱是否属于猎豹集团（域名严格等于 cmcm.com，忽略大小写与首尾空格）。
 *
 * 严格匹配「@ 之后的域名部分」，而非子串包含，避免把 `x@notcmcm.com`、
 * `x@cmcm.com.cn`、`cmcm.com@evil.com` 之类误判为猎豹邮箱。
 */
export function isCheetahEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  // 必须有 @，且 @ 前有本地名（atIndex > 0），@ 后是域名。
  if (atIndex <= 0) return false;
  const domain = normalized.slice(atIndex + 1);
  return domain === CHEETAH_EMAIL_DOMAIN;
}

/**
 * 把一行文本包装成高亮样式（加粗 + 黄色），并以 RESET 收尾防止颜色泄漏到后续行。
 */
export function highlightHintLine(text: string): string {
  return `${BOLD}${COLOR_YELLOW}${text}${RESET_COLOR}`;
}
