/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 *
 * 飞书机器人「应用必需权限」清单（对齐 openclaw-lark 的 REQUIRED_APP_SCOPES）。
 *
 * 用途：
 *  1. 在 setup 流程结尾生成「一键申请权限」链接，引导用户去飞书后台一键开权限
 *  2. probe 时与应用已开通 scope 比对，输出「缺失的 scope 列表」
 *  3. doctor / status 命令做"健康度自检"
 *
 * 一键申请链接格式（飞书官方支持）：
 *   https://open.feishu.cn/app/{appId}/auth?q={scope1,scope2,...}&op_from=dvcode&token_type=tenant
 *
 * - `q=` 用逗号分隔传需要的 scope 列表（URLEncode）
 * - `token_type=tenant` 是应用级权限（机器人主要走这个）
 * - `op_from=dvcode` 来源追踪标记
 *
 * 注意：DeepVCode 当前只用机器人发收消息 + 建群 + 卡片 + 文件资源，不涉及日历/文档/多维表格，
 * 因此这里的清单**精简过**，只保留对 dvcode 飞书 Bot 必需的 scope。
 */

import type { FeishuCredentials } from './credentials.js';

/** 飞书品牌：feishu（国内）/ lark（海外）。 */
export type LarkBrand = FeishuCredentials['domain'];

// ---------------------------------------------------------------------------
// 必需的应用级 scope（对 dvcode 飞书 Bot 来说）
// ---------------------------------------------------------------------------

/**
 * dvcode 飞书 Bot 运行所必需的应用 scope（**全部免审**）。
 *
 * 对齐 openclaw-lark `tool-scopes.ts` 的 REQUIRED_APP_SCOPES，但**精简**到 dvcode 实际用到：
 * - 收发消息：im:message:*
 * - 群管理：im:chat:*
 * - 资源（文件/图片）：im:resource
 * - 卡片：cardkit:card:*
 * - 应用自身权限查询（让 dvcode 能 probe 已开通的 scope）：application:application:self_manage
 *
 * ⚠️ 关于"群消息免 @"：这里的 `im:message.group_at_msg:readonly` 只能让 bot 收到
 * 群里**@bot 的消息**。如果要在群里**无需 @ 直接响应所有用户消息**，必须额外申请
 * `im:message.group_msg`（敏感权限，需飞书人工审核）—— 见下方 SENSITIVE_GROUP_MSG_SCOPE。
 */
export const REQUIRED_APP_SCOPES = [
  // 消息接收（群里 @bot 触发 + 私聊全收）
  'im:message.group_at_msg:readonly', // 接收群中 @bot 的消息
  'im:message.p2p_msg:readonly',      // 接收私聊消息
  'im:message:readonly',              // 通过 API 主动读取消息内容（不是事件触发，是查询权限）

  // 消息发送 / 编辑 / 撤回
  'im:message:send_as_bot',           // 以 bot 身份发消息
  'im:message:update',                // 更新（编辑）已发消息
  'im:message:recall',                // 撤回机器人发送的消息

  // 表情回复（"思考中"反馈）
  'im:message.reactions:read',
  'im:message.reactions:write_only',

  // 群管理（建群、群信息、群名）
  'im:chat',                          // 创建/管理群（dvcode 需要建项目群）
  'im:chat:read',                     // 读取群信息（成员、设置）
  'im:chat:update',                   // 修改群（设群名）

  // 资源（图片/文件上传下载）
  'im:resource',

  // 卡片交互（dvcode 用流式卡片显示进度）
  'cardkit:card:read',
  'cardkit:card:write',

  // 应用自身权限查询（让 dvcode probe 已开通哪些 scope）
  'application:application:self_manage',

  // 通讯录基础（取群成员/发送人姓名展示）
  'contact:user.base:readonly',
] as const;

export type RequiredAppScope = (typeof REQUIRED_APP_SCOPES)[number];

/**
 * 「群消息免 @」敏感权限。
 *
 * dvcode 飞书 Bot 默认在群里**只在被 @ 时**才响应（飞书事件层硬规则：
 * `im.message.receive_v1` 在群聊场景默认只推送 @bot 的消息）。
 *
 * 如果用户希望 bot 在专属项目群里**无需 @ 自动响应所有消息**，必须额外申请
 * 这个**敏感权限**。它需要飞书开放平台**人工审核**（一般 1~3 天，要在
 * 申请页面填写"使用场景说明"）。
 *
 * 一旦此权限审核通过并发布版本：
 *  - `im.message.receive_v1` 事件会推送群里**所有**用户消息（不含其他 bot）
 *  - dvcode 应用层无需做改动，gateway 会自动收到所有事件
 *
 * 文档：https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
 */
export const SENSITIVE_GROUP_MSG_SCOPE = 'im:message.group_msg' as const;

// ---------------------------------------------------------------------------
// 「一键申请权限」链接生成
// ---------------------------------------------------------------------------

/** 飞书 / Lark 的 open-platform 域名根。 */
export function openPlatformDomain(brand?: LarkBrand): string {
  return brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

/**
 * 生成飞书「一键申请权限」链接。
 *
 * 用户点击此链接后，飞书会跳转到该应用的权限管理页，并自动**预选**好 q 中列出的 scope，
 * 用户只需要点 "申请发布"或"申请权限"按钮即可，无需手工勾选。
 *
 * @param appId    飞书应用 ID
 * @param scopes   要预选申请的 scope 列表
 * @param brand    'feishu' / 'lark'，默认 'feishu'
 * @param tokenType 'tenant'（应用级，默认）/ 'user'（用户级 OAuth）
 * @returns 一键申请 URL
 */
export function buildScopeApplyUrl(params: {
  appId: string;
  scopes: readonly string[];
  brand?: LarkBrand;
  tokenType?: 'tenant' | 'user';
}): string {
  const { appId, scopes, brand, tokenType = 'tenant' } = params;
  const openDomain = openPlatformDomain(brand);

  // 飞书后端对单链接 q 个数有上限（实测 < 20 个比较稳）。
  // 当 scope 太多时，退化成"不预选 scope，直接打开权限管理页"的链接。
  const useFullList = scopes.length > 0 && scopes.length < 20;
  if (useFullList) {
    const q = encodeURIComponent(scopes.join(','));
    return `${openDomain}/app/${appId}/auth?q=${q}&op_from=dvcode&token_type=${tokenType}`;
  }
  return `${openDomain}/app/${appId}/auth?op_from=dvcode&token_type=${tokenType}`;
}

/**
 * 生成「权限管理总览页」链接（给用户兜底，看自己已开/未开哪些 scope）。
 */
export function buildPermissionPageUrl(params: { appId: string; brand?: LarkBrand }): string {
  return `${openPlatformDomain(params.brand)}/app/${params.appId}/permission`;
}

/**
 * 生成「事件订阅配置页」链接。
 *
 * dvcode Bot 必须订阅以下事件才能正常工作（飞书后台目前不能通过 q= 一键预选事件，
 * 用户需要在该页面手动勾选）：
 *  - im.message.receive_v1
 *  - im.chat.member.bot.added_v1（可选，bot 被拉入群后自动欢迎）
 *  - card.action.trigger（卡片按钮回调）
 */
export function buildEventSubUrl(params: { appId: string; brand?: LarkBrand }): string {
  return `${openPlatformDomain(params.brand)}/app/${params.appId}/event-sub`;
}

// ---------------------------------------------------------------------------
// scope 比对工具
// ---------------------------------------------------------------------------

/**
 * 求集合 A 相对集合 B 的缺失项（A 中没有的 B 元素）。
 */
export function missingScopes(
  granted: readonly string[],
  required: readonly string[],
): string[] {
  const grantedSet = new Set(granted);
  return required.filter((s) => !grantedSet.has(s));
}
