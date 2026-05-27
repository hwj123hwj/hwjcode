/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `/feishu` 命令 — dvcode 飞书 Bot 接入
 *
 * 子命令：
 *   /feishu           — 交互式启动（默认档 1 扫码，可选档 3 手动）
 *   /feishu setup     — 配置凭据（扫码建应用或手动输入）
 *   /feishu start     — 启动飞书 WS 长连接
 *   /feishu stop      — 停止飞书 WS 长连接
 *   /feishu status    — 查看连接状态
 *   /feishu logout    — 清除凭证
 */

import qrcodeTerminal from 'qrcode-terminal';
import { createRequire } from 'node:module';
const requireFn = createRequire(import.meta.url);
import { CommandKind, SlashCommand, SlashCommandActionReturn, CommandContext } from './types.js';
import { MessageType } from '../types.js';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  isSenderAuthorized,
  CredentialsLoadError,
  FeishuCredentials,
} from '../../services/feishu/credentials.js';
import {
  initRegistration,
  beginRegistration,
  pollRegistration,
  probeCredentials,
} from '../../services/feishu/registration.js';
import { FeishuGateway, FeishuMessage } from '../../services/feishu/gateway.js';
import { SendFeishuFileTool } from '../../services/feishu/feishu-send-file-tool.js';
import {
  REQUIRED_APP_SCOPES,
  SENSITIVE_GROUP_MSG_SCOPE,
  buildScopeApplyUrl,
  buildEventSubUrl,
  buildPermissionPageUrl,
  missingScopes as computeMissingScopes,
} from '../../services/feishu/scopes.js';
import {
  executeToolCall,
  ToolRegistry,
  GeminiEventType,
  ToolCallRequestInfo,
  SessionManager,
  isWithinRoot,
  getVersion,
  tokenLimit,
  uiTelemetryService,
  Config,
  GeminiClient,
  BaseTool,
  ToolResult,
  Icon,
  AuthType,
} from 'deepv-code-core';
import { SettingScope } from '../../config/settings.js';
import { getAvailableModels } from './modelCommand.js';
import { getCreditsService } from '../../services/creditsService.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { dlog, dwarn, derror } from '../../services/feishu/logger.js';
import { t, tp } from '../utils/i18n.js';
import { Part, PartListUnion, Type } from '@google/genai';

/** 当前全局网关实例（进程内单例） */
let activeGateway: FeishuGateway | null = null;

/** TUI 上下文引用（用于同步显示飞书消息到 UI） */
let tuiContext: CommandContext['ui'] | null = null;

/** 当前活跃的飞书会话信息（用于 send_feishu_file 工具发送文件） */
let activeChatId: string | null = null;
let activeReplyToMessageId: string | null = null;

/** 当前正在运行任务的中止控制器 */
let activeAbortController: AbortController | null = null;

/** 各会话的最新消息 ID (用于文件发送工具，完全线程安全，多群独立) */
const chatLastMessageId = new Map<string, string>();

/** 各会话当前活跃的发送者 OpenID */
const activeSenderOpenIds = new Map<string, string>();

/** 各会话独立运行任务的中止控制器 (完全并发安全，允许不同群独立 /stop 中止) */
const activeAbortControllers = new Map<string, AbortController>();

/** 全局命令上下文引用 */
let globalCommandContext: CommandContext | null = null;

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface FeishuProjectRoute {
  projectRoot: string;
  description?: string;
}

// 路由文件路径（指向 ~/.deepv/feishu-projects.json）
const ROUTE_CONFIG_FILE = path.join(os.homedir(), '.deepv', 'feishu-projects.json');

/**
 * 读取多项目路由表
 */
async function loadProjectRoutes(): Promise<Record<string, FeishuProjectRoute>> {
  try {
    const credsDir = path.dirname(ROUTE_CONFIG_FILE);
    if (!fs.existsSync(credsDir)) {
      fs.mkdirSync(credsDir, { recursive: true });
    }
    if (!fs.existsSync(ROUTE_CONFIG_FILE)) {
      return {};
    }
    const data = fs.readFileSync(ROUTE_CONFIG_FILE, 'utf8');
    return JSON.parse(data) as Record<string, FeishuProjectRoute>;
  } catch (e) {
    dwarn(`Failed to load feishu-projects.json: ${(e as Error).message}`);
    return {};
  }
}

/**
 * 写入路由表
 */
async function saveProjectRoute(chatId: string, route: FeishuProjectRoute): Promise<void> {
  try {
    const routes = await loadProjectRoutes();
    routes[chatId] = route;
    fs.writeFileSync(ROUTE_CONFIG_FILE, JSON.stringify(routes, null, 2), 'utf8');
    dlog(`[Router] Successfully bound Chat ID '${chatId}' to '${route.projectRoot}'`);
  } catch (e) {
    derror(`Failed to save feishu-projects.json: ${(e as Error).message}`);
  }
}

/** 当前活跃的发送者 OpenID (用于拉当前交互的人建群) */
let activeSenderOpenId: string | null = null;

/** 隔离的运行时环境缓存 (chatId -> { config, geminiClient }) */
const isolatedSessions = new Map<string, { config: Config; geminiClient: GeminiClient }>();

interface QueuedMessage {
  msg: FeishuMessage;
  resolve: (value: any) => void;
  reject: (err: any) => void;
}

// 群聊独立的队列容器
const messageQueues = new Map<string, QueuedMessage[]>();
const isProcessingQueues = new Map<string, boolean>();

function clearMessageQueue() {
  for (const queue of messageQueues.values()) {
    for (const item of queue) {
      item.resolve(null);
    }
  }
  messageQueues.clear();
  isProcessingQueues.clear();
  isolatedSessions.clear();
  chatLastMessageId.clear();
  activeSenderOpenIds.clear();
  for (const controller of activeAbortControllers.values()) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
  activeAbortControllers.clear();
  activeSenderOpenId = null;
}

/**
 * Wrapper around loadCredentials that surfaces decryption / parse errors
 * as a typed result instead of throwing — handlers can produce a friendly
 * actionable message instead of a stack trace.
 */
async function loadCredsSafe(): Promise<
  | { ok: true; creds: FeishuCredentials | null }
  | { ok: false; error: string }
> {
  try {
    const creds = await loadCredentials();
    return { ok: true, creds };
  } catch (e) {
    if (e instanceof CredentialsLoadError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 构建帮助文本
 */
function helpText(): string {
  return t('feishu.help.text');
}

async function handleSetup(args: string, ctx?: CommandContext): Promise<string> {
  const trimmed = args.trim();
  // 手动检测 --manual 模式，不走 parseArgs（避免 flag 值吃掉后续参数）
  const manualMatch = trimmed.match(/^--manual\s+(.+)$/s);
  if (manualMatch) {
    // --manual 之后的所有非空参数，以空格分割
    const rest = manualMatch[1].trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    const appId = parts[0];
    const appSecret = parts[1];
    return await handleManualSetup(appId, appSecret, ctx);
  }

  // 没有 --manual 则走 QR
  return await handleQrSetup(ctx);
}

/**
 * 渲染一个 ASCII 二维码（紧凑模式，TUI 友好）。
 *
 * qrcode-terminal 默认会用空格 + █ 字符渲染，small 模式用半角块字符
 * 让二维码体积减半，更适合 TUI 窗口显示。
 *
 * 注意：qrcode-terminal 的 generate 是**同步** 调用 callback 的（没有任何 IO），
 * 所以可以直接通过闭包变量收集结果。
 *
 * 失败时返回 null，调用方可以降级到"只展示链接"。
 */
function renderQrCode(text: string): string | null {
  try {
    let output = '';
    let qt: any = qrcodeTerminal;

    // 🎯 1. 尝试直接以方法调用的形式在原始对象上调用，以保留正确的 `this` 上下文（否则会因 this 丢失导致 this.error 变成 undefined 进而报错）
    if (qt && typeof qt.generate === 'function') {
      qt.generate(text, { small: true }, (qr: string) => {
        output = qr;
      });
      return output || null;
    }

    if (qt && qt.default && typeof qt.default.generate === 'function') {
      qt.default.generate(text, { small: true }, (qr: string) => {
        output = qr;
      });
      return output || null;
    }

    // 🎯 2. 兜底尝试使用 requireFn 并以方法调用形式执行
    try {
      const cjsQt = requireFn('qrcode-terminal');
      if (cjsQt && typeof cjsQt.generate === 'function') {
        cjsQt.generate(text, { small: true }, (qr: string) => {
          output = qr;
        });
        return output || null;
      }
      if (cjsQt && cjsQt.default && typeof cjsQt.default.generate === 'function') {
        cjsQt.default.generate(text, { small: true }, (qr: string) => {
          output = qr;
        });
        return output || null;
      }
    } catch {
      // 忽略 require 失败
    }

    dwarn('[Feishu] qrcodeTerminal.generate is not a function');
    return null;
  } catch (e: any) {
    dwarn(`[Feishu] renderQrCode failed: ${e?.message || e}`);
    return null;
  }
}

/**
 * 档 1：扫码自动建应用
 *
 * 两阶段返回：
 *  阶段 1（同步返回）：立刻渲染二维码 + 链接 + 等待提示，让用户**马上**看见可扫码内容。
 *  阶段 2（后台异步）：等用户扫码后，通过 ctx.ui.addItem 把后续状态/结果一条一条 push 到
 *                      history。这样 TUI 不会卡住等 60+ 秒，扫码体验非常流畅。
 *
 * 没有 ctx（被非交互式 CLI 调用，如 `dvcode -p`）时退化回单次同步返回。
 */
async function handleQrSetup(ctx?: CommandContext): Promise<string> {
  const lines: string[] = [t('feishu.setup.qr.title')];
  lines.push(t('feishu.setup.qr.connecting'));

  try {
    await initRegistration('feishu');
    const begin = await beginRegistration('feishu');
    const qrUrl = begin.qrUrl;

    // ============= 阶段 1：立刻拼好「二维码 + 链接 + 扫码提示」一并返回 =============
    lines.push(t('feishu.setup.qr.generated'));
    lines.push('');

    // ASCII QR 码 — 紧凑模式，适合 TUI 窗口
    const qrAscii = renderQrCode(qrUrl);
    if (qrAscii) {
      lines.push(qrAscii);
    }

    lines.push('');
    lines.push('  📱 ' + t('feishu.setup.qr.scan_hint'));
    lines.push('');
    lines.push('  🔗 备选：在浏览器打开此链接登录授权');
    lines.push(`     ${qrUrl}`);
    lines.push('');
    lines.push(t('feishu.setup.qr.waiting'));
    lines.push(t('feishu.setup.qr.cancel_hint'));

    // 没有 ctx → 非交互式调用，必须用旧的同步等待逻辑
    if (!ctx) {
      const pollResult = await pollRegistration(
        begin.deviceCode,
        begin.interval,
        begin.expireIn,
        'feishu',
      );
      if (!pollResult) {
        lines.push('');
        lines.push(t('feishu.setup.qr.timeout'));
        lines.push(t('feishu.setup.qr.retry_hint'));
        return lines.join('\n');
      }
      const result = await finalizeQrSetup(pollResult);
      lines.push('');
      lines.push(result);
      return lines.join('\n');
    }

    // ============= 阶段 2：交互模式 — 后台 await，扫码完成后 push 到 history =============
    void (async () => {
      try {
        const pollResult = await pollRegistration(
          begin.deviceCode,
          begin.interval,
          begin.expireIn,
          'feishu',
        );
        if (!pollResult) {
          ctx.ui.addItem(
            {
              type: MessageType.INFO,
              text: [
                '',
                t('feishu.setup.qr.timeout'),
                t('feishu.setup.qr.retry_hint'),
              ].join('\n'),
            },
            Date.now(),
          );
          return;
        }
        const result = await finalizeQrSetup(pollResult, ctx);
        ctx.ui.addItem(
          { type: MessageType.INFO, text: result },
          Date.now(),
        );
      } catch (err: any) {
        ctx.ui.addItem(
          {
            type: MessageType.ERROR,
            text: `❌ Feishu setup 后台轮询失败：${err?.message || err}`,
          },
          Date.now(),
        );
      }
    })();

    return lines.join('\n');
  } catch (err: any) {
    return [
      t('feishu.setup.qr.failed_title'),
      `  ${err.message}`,
      '',
      t('feishu.setup.qr.fallback_hint'),
    ].join('\n');
  }
}

/**
 * 阶段 2 的收尾：拿到 device-code 轮询结果后，做 probe + 保存凭证 + 拼最终提示。
 * 提取成独立函数是为了让交互式与非交互式两条调用路径共享同一段逻辑。
 */
async function finalizeQrSetup(
  pollResult: {
    appId: string;
    appSecret: string;
    domain: string;
    openId?: string;
  },
  ctx?: CommandContext,
): Promise<string> {
  const lines: string[] = [];
  const botInfo = await probeCredentials(
    pollResult.appId, pollResult.appSecret, pollResult.domain,
  );

  const creds: FeishuCredentials = {
    appId: pollResult.appId,
    appSecret: pollResult.appSecret,
    domain: pollResult.domain as 'feishu' | 'lark',
    botName: botInfo?.botName,
    botOpenId: botInfo?.botOpenId,
    // The user who scanned the QR code becomes the Bot owner — only they
    // (and entries in `allowlist`) may invoke the agent. See B1 in MR review.
    ownerOpenId: pollResult.openId,
  };

  await saveCredentials(creds);

  lines.push(t('feishu.setup.qr.success'));
  lines.push(`  App ID:      ${creds.appId}`);
  if (creds.botName) lines.push(tp('feishu.setup.qr.bot_name', { name: creds.botName }));
  lines.push(t('feishu.setup.qr.creds_saved'));

  // ✨ 关键升级：检测应用已开通的 scope，输出"一键申请缺失权限"链接
  appendPostSetupGuidance(lines, creds, botInfo?.grantedScopes);

  // 🚀 自动帮用户执行 start 逻辑以启动监听服务
  try {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🚀 **正在为您自动开启飞书 Bot 监听服务...**');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const startMsg = await handleStart(ctx);
    lines.push(startMsg);
  } catch (err: any) {
    lines.push(`❌ 自动启动服务失败：${err?.message || err}`);
  }

  lines.push('');
  lines.push(t('feishu.setup.qr.next_step_start'));
  return lines.join('\n');
}

/**
 * 在 setup 流程结束时附加「下一步配置」引导：
 *  1. 一键申请缺失的应用 scope（飞书开放平台原生支持 q= 参数预选 scope）
 *  2. 事件订阅页（im.message.receive_v1 等）
 *  3. 权限管理总览页（兜底）
 *
 * 这一段对齐 openclaw-lark `commands/doctor.ts` 的逻辑，但内嵌在 setup 成功
 * 时直接输出，而不是单独的 doctor 命令。
 */
function appendPostSetupGuidance(
  lines: string[],
  creds: FeishuCredentials,
  grantedScopes?: string[],
): void {
  const requiredAll = [...REQUIRED_APP_SCOPES];
  const missing = grantedScopes
    ? computeMissingScopes(grantedScopes, requiredAll)
    : requiredAll; // 没拿到已开通列表（首次扫码很正常）→ 假定全部缺失

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('🔧 **一键完成下一步配置（强烈建议）**');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (grantedScopes !== undefined && missing.length === 0) {
    lines.push('  ✅ 应用已开通全部 dvcode 必需的 scope，无需额外申请。');
  } else {
    const scopeApplyUrl = buildScopeApplyUrl({
      appId: creds.appId,
      scopes: missing,
      brand: creds.domain,
      tokenType: 'tenant',
    });
    if (grantedScopes === undefined) {
      lines.push('  📋 **第 1 步：一键申请应用所需权限**（自动预选 scope）');
    } else {
      lines.push(`  📋 **第 1 步：一键申请缺失的 ${missing.length} 项权限**（自动预选 scope）`);
    }
    lines.push(`     👉 ${scopeApplyUrl}`);
    if (missing.length > 0 && missing.length <= 12) {
      lines.push('     需申请的 scope：');
      for (const s of missing) lines.push(`       - ${s}`);
    }
  }

  lines.push('');
  lines.push('  📡 **第 2 步：在事件订阅页勾选必要事件**');
  lines.push(`     👉 ${buildEventSubUrl({ appId: creds.appId, brand: creds.domain })}`);
  lines.push('     需订阅事件：');
  lines.push('       - im.message.receive_v1（接收消息）');
  lines.push('       - im.chat.member.bot.added_v1（被拉入群通知）');
  lines.push('       - card.action.trigger（卡片按钮回调）');
  lines.push('');
  lines.push('  🔄 **第 3 步：申请发布版本**');
  lines.push('     在权限管理页申请版本发布，让 scope 生效：');
  lines.push(`     👉 ${buildPermissionPageUrl({ appId: creds.appId, brand: creds.domain })}`);
  lines.push('');

  // 🔔 重要提示：群里免 @ 必须额外申请敏感权限
  const hasGroupMsgScope = grantedScopes?.includes(SENSITIVE_GROUP_MSG_SCOPE) ?? false;
  if (!hasGroupMsgScope) {
    const sensitiveApplyUrl = buildScopeApplyUrl({
      appId: creds.appId,
      scopes: [SENSITIVE_GROUP_MSG_SCOPE],
      brand: creds.domain,
      tokenType: 'tenant',
    });
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('💬 **想让 Bot 在群里"免 @ 直接响应所有消息"？**');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('  默认：群里只有 @bot 时才会收到事件（飞书平台层硬规则）。');
    lines.push('  要免 @ 直接响应，必须额外申请「敏感权限」：');
    lines.push(`     👉 ${sensitiveApplyUrl}`);
    lines.push(`     权限：\`${SENSITIVE_GROUP_MSG_SCOPE}\` —— "读取关联群聊内所有消息"`);
    lines.push('  ⚠️ 这是飞书的敏感权限，需要人工审核（一般 1-3 天）。');
    lines.push('  在申请页填写"使用场景说明"时，可以参考填写：');
    lines.push('     用于 AI 编程助手在专属项目协作群中无需 @ 即可响应团队成员的');
    lines.push('     编程请求和问题，提升协作效率。');
    lines.push('');
  }
  lines.push('  💡 步骤 1-3 完成后，回到 dvcode 执行 `/feishu start` 即可使用！');
}

/**
 * 档 3：手动输入凭据
 */
async function handleManualSetup(
  appId?: string,
  appSecret?: string,
  ctx?: CommandContext,
): Promise<string> {
  if (!appId || !appSecret) {
    return [
      t('feishu.setup.manual.title'),
      '',
      t('feishu.setup.manual.usage'),
      '',
      t('feishu.setup.manual.example'),
      '',
      t('feishu.setup.manual.where_to_find'),
      '',
      t('feishu.setup.manual.tip_qr'),
    ].join('\n');
  }

  // 校验凭证
  const lines: string[] = [t('feishu.setup.manual.validating')];
  const botInfo = await probeCredentials(appId, appSecret, 'feishu');

  const creds: FeishuCredentials = {
    appId,
    appSecret,
    domain: 'feishu',
    botName: botInfo?.botName,
    botOpenId: botInfo?.botOpenId,
  };

  await saveCredentials(creds);

  lines.push(botInfo ? t('feishu.setup.manual.creds_valid') : t('feishu.setup.manual.creds_invalid'));
  if (creds.botName) lines.push(tp('feishu.setup.qr.bot_name', { name: creds.botName }));
  lines.push(t('feishu.setup.qr.creds_saved'));
  lines.push('');
  lines.push(t('feishu.setup.manual.owner_warning'));
  lines.push(t('feishu.setup.manual.owner_warning_2'));

  // ✨ 与 QR setup 一致，附加「一键开权限」+ 事件订阅引导
  appendPostSetupGuidance(lines, creds, botInfo?.grantedScopes);

  // 🚀 手动配置成功后，也自动帮用户执行 start 逻辑以启动监听服务
  try {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🚀 **正在为您自动开启飞书 Bot 监听服务...**');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const startMsg = await handleStart(ctx);
    lines.push(startMsg);
  } catch (err: any) {
    lines.push(`❌ 自动启动服务失败：${err?.message || err}`);
  }

  lines.push('');
  lines.push(t('feishu.setup.qr.next_step_start'));

  return lines.join('\n');
}

/**
 * 从文本中提取文件路径，上传并发送到飞书
 *
 * 安全约束（B2）：仅发送项目根目录内、且扩展名在白名单中的文件。
 * 跨平台支持：同时识别 POSIX 路径（/foo/bar.ext, ./foo.ext）和 Windows 路径
 *   （C:\foo\bar.ext, .\foo.ext）。
 *
 * 不在白名单内的扩展名一律不发送，可疑路径（绝对路径但不在 projectRoot 内）
 * 也会被忽略，避免文本中提及的路径被自动外发到飞书。
 */
async function sendDetectedFiles(
  gateway: FeishuGateway,
  chatId: string,
  replyToMessageId: string | undefined,
  text: string,
  projectRoot: string,
): Promise<void> {
  // 文件路径正则 — 同时匹配 POSIX 与 Windows 风格：
  //   POSIX：/abs/path/file.ext, ./rel/path/file.ext
  //   Windows：C:\abs\path\file.ext, .\rel\path\file.ext
  // 反斜杠在 JSON/markdown 中常被双写为 \\，正则用 [\\\\/] 匹配 / 或 \。
  const filePathRegex =
    /(?:^|[\s"'`])((?:[A-Za-z]:[\\/][\w\-./\\]+)|(?:\/[\w\-./]+)|(?:\.[\\/][\w\-./\\]+))\.(png|jpe?g|gif|webp|svg|bmp|pdf|txt|csv|json|zip|tar\.gz|py|js|ts|tsx|jsx|md|html|css|yaml|yml|toml)(?=["'`\s,;.)]|$)/gim;

  type Match = { path: string; ext: string };
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = filePathRegex.exec(text)) !== null) {
    const filePath = m[1] + '.' + m[2];
    if (!matches.some((x) => x.path === filePath)) {
      matches.push({ path: filePath, ext: m[2].toLowerCase() });
    }
  }
  if (matches.length === 0) return;

  const fs = await import('node:fs');
  const path = await import('node:path');

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
  const REJECTED_EXTS = new Set([
    'exe', 'dll', 'bat', 'cmd', 'ps1', 'msi', 'scr', 'com',
    'so', 'dylib', 'sh', 'bash', 'zsh', 'fish',
    'jar', 'class', 'msp', 'msc',
  ]);

  for (const { path: rawPath, ext } of matches) {
    if (REJECTED_EXTS.has(ext)) {
      dwarn(`Rejected suspicious extension .${ext}: ${rawPath}`);
      continue;
    }

    // Resolve to absolute, then enforce project-root sandbox.
    const abs = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(projectRoot, rawPath);
    if (!isWithinRoot(abs, projectRoot)) {
      dwarn(`Rejected file outside project root: ${abs}`);
      continue;
    }

    try {
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      // 50 MiB cap; matches send_feishu_file tool.
      if (stat.size > 50 * 1024 * 1024) {
        dwarn(`Rejected file > 50 MiB: ${abs} (${stat.size} bytes)`);
        continue;
      }

      if (IMAGE_EXTS.has(ext)) {
        const imageKey = await gateway.uploadImage(abs);
        await gateway.sendImage(chatId, imageKey, replyToMessageId);
        tuiContext?.addItem(
          { type: 'info', text: tp('feishu.send.image', { path: abs }) },
          Date.now(),
        );
      } else {
        const fileKey = await gateway.uploadFile(abs);
        await gateway.sendFile(chatId, fileKey, replyToMessageId);
        tuiContext?.addItem(
          { type: 'info', text: tp('feishu.send.file', { path: abs }) },
          Date.now(),
        );
      }
    } catch (err: unknown) {
      derror(`Failed to send file to Feishu (${abs}):`, (err as Error)?.message);
      // 文件发送失败不影响主流程
    }
  }
}

/**
 * 飞书模式下拦截 ask_user_question：发送交互卡片，等用户点按钮
 *
 * 交互方式：发送选项列表（markdown），用户回复序号或选项名称来选择。
 * （飞书 WebSocket 长连接不支持卡片回调，因此使用文本选择模式）
 *
 * 超时（60s）→ 自动返回"用户未回答"
 */
async function handleAskUserQuestionViaCard(
  gateway: FeishuGateway,
  chatId: string,
  replyToMessageId: string | undefined,
  args: {
    questions?: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  },
  callId: string,
): Promise<Part> {
  const questions = args.questions || [];
  const answers: Record<string, string> = {};

  for (const q of questions) {
    const options = q.options || [];
    if (options.length === 0) {
      answers[q.question] = '(无选项)';
      continue;
    }

    // 构建卡片正文：列出选项及其描述
    const contentLines = options.map((opt, i) => {
      const line = `**${opt.label}**`;
      return opt.description ? `${line}: ${opt.description}` : line;
    });
    const content = contentLines.join('\n\n');

    // 构建按钮
    const buttons = options.map((opt) => ({
      label: opt.label,
      value: opt.label,
    }));
    // 添加"跳过"按钮
    buttons.push({ label: '⏭ 跳过', value: '__skip__' });

    const title = q.header ? `${q.header}: ${q.question}` : q.question;

    // 发送卡片并等待用户点击
    const userChoice = await gateway.waitForCardAction(
      chatId,
      title,
      content,
      buttons,
      '__timeout__', // 默认值（超时）
      60000,         // 60 秒超时
      replyToMessageId,
    );

    // 发送新消息提示用户的选择结果
    {
      let feedbackText: string;
      if (userChoice === '__timeout__') {
        feedbackText = '⏰ 等待超时 — 未收到回答';
      } else if (userChoice === '__skip__') {
        feedbackText = '⏭ 已跳过';
      } else {
        feedbackText = `✅ 已选择: ${userChoice}`;
      }
      await gateway.sendMessage(chatId, feedbackText);
    }

    if (userChoice === '__timeout__') {
      answers[q.question] = '用户未在 60 秒内回答，请自行决策';
    } else if (userChoice === '__skip__') {
      answers[q.question] = '用户选择跳过，请自行决策';
    } else {
      answers[q.question] = userChoice;
    }
  }

  // 构造和 AskUserQuestionTool.execute() 相同格式的 functionResponse
  const parts = Object.entries(answers).map(
    ([questionText, answer]) => `"${questionText}"="${answer}"`,
  );
  const answersText = parts.join(', ');
  const llmContent = answersText
    ? `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`
    : 'User has answered your questions (no answers provided).';

  return {
    functionResponse: {
      id: callId,
      name: 'ask_user_question',
      response: { output: llmContent },
    },
  } as Part;
}

/** 飞书支持的斜杠命令列表（用于 /help 展示） */
const FEISHU_SLASH_COMMANDS: Record<string, string> = {
  '/new':      '新建会话（重置对话历史，保留工具能力）',
  '/compress': '压缩对话历史（释放上下文窗口）',
  '/compact':  '同 /compress',
  '/stop':     '中止当前正在运行的 AI 任务',
  '/status':   '查看当前的 CLI 版本、积分剩余、当前模型、思考模式及上下文大小',
  '/thinking': '切换/配置 AI 思考模式与深度',
  '/model':    '查看可用模型，或输入 `/model <模型ID>` 切换 AI 模型',
  '/help':     '显示此帮助',
};

/**
 * 处理飞书端的斜杠命令（不发给 LLM，本地执行）
 *
 * 返回 null 表示不是命令，应走 LLM agent 流程
 */
async function handleFeishuCommand(
  messageText: string,
  geminiClient: any,
  config: any,
  chatId?: string,
): Promise<string | null> {
  const cmd = messageText.split(/\s+/)[0].toLowerCase();

  switch (cmd) {
    case '/new': {
      try {
        await geminiClient.resetChat();
        // 同时创建新的 session 记录
        const sessionManager = new SessionManager(config?.getProjectRoot() || process.cwd());
        const newSession = await sessionManager.createNewSession(undefined, process.cwd());
        return `✅ 新会话已创建\n📝 Session ID: ${newSession.sessionId}\n💬 可以开始新的对话了`;
      } catch (err: any) {
        return `❌ 创建新会话失败: ${err.message}`;
      }
    }

    case '/compress':
    case '/compact': {
      try {
        const promptId = `feishu-compress-${Date.now()}`;
        const result = await geminiClient.tryCompressChat(
          promptId,
          new AbortController().signal,
          true,
        );
        if (result) {
          return `✅ 对话已压缩\n📦 原始 token: ${result.originalTokenCount}\n📦 压缩后 token: ${result.newTokenCount}`;
        }
        return '⚠️ 没有需要压缩的内容';
      } catch (err: any) {
        return `❌ 压缩失败: ${err.message}`;
      }
    }

    case '/stop': {
      const controller = chatId ? activeAbortControllers.get(chatId) : activeAbortController;
      if (controller) {
        controller.abort();
        if (chatId) {
          activeAbortControllers.delete(chatId);
        } else {
          activeAbortController = null;
        }
        return '🛑 已中止当前正在运行的 AI 任务。';
      }
      return '⚠️ 当前没有正在运行的 AI 任务。';
    }

    case '/status': {
      try {
        const cliVersion = await getVersion().catch(() => 'unknown');

        let creditsStr = '获取失败';
        try {
          const creditsInfo = await getCreditsService().getCreditsInfo(true);
          if (creditsInfo) {
            creditsStr = `${creditsInfo.remainingCredits.toLocaleString()} / ${creditsInfo.totalCredits.toLocaleString()} (已用: ${creditsInfo.usedCredits.toLocaleString()} Credits)`;
          }
        } catch (e) {
          creditsStr = '未知';
        }

        const currentModel = config?.getModel() || '未选择';
        const cloudModelInfo = config?.getCloudModelInfo?.(currentModel);
        const modelDisplayName = cloudModelInfo?.displayName || currentModel;

        const currentConfig = config?.getThinkingConfig() || { mode: 'auto', effort: 'auto' };
        const thinkingStr = `${currentConfig.mode === 'on' ? '开启' : currentConfig.mode === 'off' ? '关闭' : '自动'} (力度: ${currentConfig.effort || 'auto'})`;

        const maxTokens = tokenLimit(currentModel, config || undefined);
        const actualPromptTokens = uiTelemetryService.getLastPromptTokenCount();

        return [
          `📊 **DeepV Code CLI 状态面板**`,
          `───────────────────────`,
          `🤖 **当前模型**: ${modelDisplayName}`,
          `💭 **思考模式**: ${thinkingStr}`,
          `📦 **上下文大小**: ${actualPromptTokens ? `${actualPromptTokens.toLocaleString()}` : '0'} / ${maxTokens ? `${maxTokens.toLocaleString()}` : '未知'} tokens`,
          `💰 **积分剩余量**: ${creditsStr}`,
          `💻 **CLI 版本**: v${cliVersion}`,
          `───────────────────────`,
        ].join('\n');
      } catch (err: any) {
        return `❌ 获取状态信息失败: ${err.message}`;
      }
    }

    case '/thinking': {
      const parts = messageText.split(/\s+/);
      if (parts.length === 1) {
        const currentConfig = config?.getThinkingConfig() || { mode: 'auto', effort: 'auto' };
        return [
          `💭 **思考配置状态**`,
          `───────────────────────`,
          `当前思考模式: **${currentConfig.mode === 'on' ? '开启' : currentConfig.mode === 'off' ? '关闭' : '自动'}**`,
          `思考强度力度: **${currentConfig.effort || 'auto'}**`,
          `───────────────────────`,
          `💡 **使用以下命令进行切换**:`,
          `  /thinking off  - 关闭思考模式`,
          `  /thinking auto - 设为自动模式`,
          `  /thinking low|medium|high|max - 开启并设置思考强度`,
        ].join('\n');
      }

      const sub = parts[1].toLowerCase();
      const currentConfig = config?.getThinkingConfig() || { mode: 'auto', effort: 'auto' };

      if (['on', 'off', 'auto'].includes(sub)) {
        const newMode = sub as 'on' | 'off' | 'auto';
        const updated = {
          ...currentConfig,
          mode: newMode,
          effort: newMode === 'auto' ? 'auto' : (currentConfig.effort ?? 'auto')
        };
        config?.setThinkingConfig?.(updated);
        globalCommandContext?.services?.settings?.setValue?.(SettingScope.User, 'thinking', updated);
        if (config) {
          appEvents.emit(AppEvent.ModelChanged, config.getModel() || '');
        }
        return `✨ 已成功将思考模式切换为: **${newMode === 'on' ? '开启' : newMode === 'off' ? '关闭' : '自动'}** (力度: ${updated.effort})`;
      } else if (['low', 'medium', 'high', 'max', 'xhigh'].includes(sub)) {
        const newEffort = sub as any;
        const updated = {
          ...currentConfig,
          mode: 'on' as const,
          effort: newEffort
        };
        config?.setThinkingConfig?.(updated);
        globalCommandContext?.services?.settings?.setValue?.(SettingScope.User, 'thinking', updated);
        if (config) {
          appEvents.emit(AppEvent.ModelChanged, config.getModel() || '');
        }
        return `✨ 已成功开启思考模式，并设置思考力度为: **${newEffort}**`;
      } else {
        return `❌ 未知的思考参数: ${parts[1]}\n请使用 off / auto / low / medium / high / max`;
      }
    }

    case '/model': {
      const parts = messageText.split(/\s+/);
      const settings = globalCommandContext?.services?.settings;
      if (!settings) {
        return '❌ settings 服务不可用，无法更改模型。';
      }

      try {
        const { modelNames, modelInfos } = await getAvailableModels(settings, config || undefined);

        if (parts.length === 1) {
          // 列出可用模型列表
          const lines = ['🤖 **可用模型列表:**', ''];
          modelInfos.forEach((m: any) => {
            let modelLine = `• **${m.name}** (${m.displayName})`;
            if (m.creditsPerRequest) {
              modelLine += ` - ${m.creditsPerRequest}x credits`;
            }
            lines.push(modelLine);
          });
          lines.push('');
          lines.push('💡 **提示**: 输入 `/model <模型名>` 即可在线切换 AI 模型');
          return lines.join('\n');
        }

        const targetModelName = parts[1].trim();
        // 查找最匹配的模型
        const exactMatch = modelInfos.find((m: any) => m.name.toLowerCase() === targetModelName.toLowerCase() || m.displayName.toLowerCase() === targetModelName.toLowerCase());

        if (!exactMatch) {
          return `❌ 未能找到模型 "${targetModelName}"，请通过输入 \`/model\` 查看可用模型列表。`;
        }

        const actualModelName = exactMatch.name;
        settings.setValue(SettingScope.User, 'preferredModel', actualModelName);

        if (config) {
          const geminiClient = config.getGeminiClient();
          if (geminiClient) {
            await geminiClient.waitForChatInitialized();
            const switchResult = await geminiClient.switchModel(actualModelName, new AbortController().signal);

            if (!switchResult.success) {
              return `❌ 切换到模型 **${exactMatch.displayName}** 失败: ${switchResult.error || '可能由于上下文压缩失败'}`;
            }

            let responseMsg = `✨ 已成功切换 AI 模型为: **${exactMatch.displayName}** (${actualModelName})`;
            if (switchResult.compressionInfo) {
              responseMsg += `\n📦 上下文已自动压缩: ${switchResult.compressionInfo.originalTokenCount} → ${switchResult.compressionInfo.newTokenCount} tokens`;
            } else if (switchResult.compressionSkipReason) {
              responseMsg += `\n✓ ${switchResult.compressionSkipReason}`;
            }

            // 🎯 发出 ModelChanged 事件，强制通知并更新 CLI 终端的 Footer 状态显示
            appEvents.emit(AppEvent.ModelChanged, actualModelName);
            return responseMsg;
          }
        }

        return `✨ 已成功切换 AI 模型为: **${exactMatch.displayName}** (${actualModelName})`;
      } catch (err: any) {
        return `❌ 切换模型失败: ${err.message}`;
      }
    }

    case '/help': {
      const lines = ['📖 飞书可用命令:', ''];
      for (const [name, desc] of Object.entries(FEISHU_SLASH_COMMANDS)) {
        lines.push(`  ${name.padEnd(12)} ${desc}`);
      }
      lines.push('');
      lines.push('💡 其他任何消息都会发送给 AI Agent 处理（支持工具调用）');
      return lines.join('\n');
    }

    default:
      return null; // 不是命令，走 LLM
  }
}

/**
 * 清理消息文本中多余的首部 @机器人 提及。
 *
 * 飞书群聊消息由于必须通过 @机器人 触发，因此传入的消息通常包含 `@dvcode2`、`@_user_1` 等前缀。
 * 本函数自动匹配并剥除这些提及前缀，使得：
 *  1. 群聊中的斜杠命令（例如 `@dvcode2 /new` 变成 `/new`）能被正确识别和拦截。
 *  2. 群聊中的绑定指令（例如 `@dvcode2 /bind d:\123` 变成 `/bind d:\123`）能顺畅执行。
 *  3. LLM 接收到纯净的提问，不易产生 @ 前缀造成的格式幻觉。
 */
function stripBotMention(text: string, botName?: string): string {
  let cleaned = text.trim();

  // 1. 剥除飞书常用的 @_user_xxx 格式提及
  cleaned = cleaned.replace(/^@_user_\d+\s*/, '');

  // 2. 剥除指定 botName 形式的提及
  if (botName) {
    const escapedName = botName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`^@${escapedName}\\s*`, 'i');
    cleaned = cleaned.replace(regex, '');
  }

  // 3. 兜底剥除通用的 @dvcode 提及
  cleaned = cleaned.replace(/^@dvcode2?\\s*/i, '');
  cleaned = cleaned.replace(/^@智能体\s*/i, ''); // 飞书自带的应用标签前缀

  return cleaned.trim();
}

/**
 * 启动网关（从已保存的凭证）
 */
async function handleStart(context?: CommandContext): Promise<string> {
  const result = await loadCredsSafe();
  if (!result.ok) {
    return tp('feishu.start.creds_load_failed', { error: result.error });
  }
  const creds = result.creds;
  if (!creds) {
    return [
      t('feishu.start.no_creds_title'),
      '',
      t('feishu.start.no_creds_setup'),
      t('feishu.start.no_creds_qr'),
      t('feishu.start.no_creds_or'),
      t('feishu.start.no_creds_manual'),
    ].join('\n');
  }

  if (activeGateway) {
    return t('feishu.start.already_running');
  }

  const gateway = new FeishuGateway(creds.appId, creds.appSecret, creds.domain);

  // 保存 TUI 上下文（用于同步消息到 UI）
  if (context?.ui) {
    tuiContext = context.ui;
  }
  globalCommandContext = context || null;

  // 获取 GeminiClient
  const config = context?.services?.config;
  const geminiClient = config?.getGeminiClient?.();

  // 设置消息处理 — 使用主会话的 agent 模式（带工具执行能力）
  gateway.onMessage = async (msg: FeishuMessage): Promise<string | null> => {
    let messageText = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!messageText) {
      return null;
    }

    // 🧹 清理消息文本中由于群聊 @ 产生的提及前缀，使群内斜杠命令（如 /new, /bind）能够正常拦截执行
    messageText = stripBotMention(messageText, creds.botName);
    if (!messageText) {
      return null;
    }

    // 🛡️ 授权检查（B1）：只允许 ownerOpenId 或 allowlist 中的 senderOpenId
    // 触发 LLM/工具调用。任何其他人发送的消息直接拒绝，绝不会进入 agent 循环
    // 或访问本地文件系统，避免 Bot 成为远程 RCE 入口。
    if (!isSenderAuthorized(creds, msg.senderOpenId)) {
      const reply = creds.ownerOpenId
        ? `🛡️ 此 Bot 仅响应授权用户。如需使用，请联系 Bot 拥有者用 \`/feishu allow ${msg.senderOpenId}\` 添加你。`
        : `🛡️ 此 Bot 尚未配置授权用户。请 Bot 拥有者在 dvcode 中执行 \`/feishu allow ${msg.senderOpenId}\` 后再试。`;
      tuiContext?.addItem(
        {
          type: 'info',
          text: tp('feishu.tui.unauthorized_log', {
            openId: msg.senderOpenId,
            text: messageText.slice(0, 60),
          }),
        },
        Date.now(),
      );
      return reply;
    }

    // 拦截群内自助绑定的 `/bind` 命令
    if (messageText.startsWith('/bind')) {
      const parts = messageText.split(/\s+/);
      if (parts.length < 2) {
        return '❌ 绑定命令格式不正确。\n格式：`/bind <您本地项目的绝对物理路径>`';
      }
      const targetPath = parts[1].trim();
      try {
        const path = await import('node:path');
        const fs = await import('node:fs');
        const absPath = path.resolve(targetPath);
        if (!fs.existsSync(absPath)) {
          fs.mkdirSync(absPath, { recursive: true });
        }
        await saveProjectRoute(msg.chatId, { projectRoot: absPath });
        return `✅ 恭喜！本群已成功绑定本地项目工作区！\n📂 **工作目录**: \`${absPath}\`\n💬 您现在可以直接在群里向我提问，我将全力协助您！`;
      } catch (e: any) {
        return `❌ 绑定目录失败: ${e.message}`;
      }
    }

    // 🎯 更新全局活跃发送人 (让建群工具可以拉当前发消息的人进新群)
    activeSenderOpenId = msg.senderOpenId;

    // 🎯 实时、动态拉取最新的 config 和 geminiClient，防止闭包在启动后变化而未感知
    const activeConfig = globalCommandContext?.services?.config || config;
    let activeClient: any = null;
    let initErrorMsg = '';
    const debugTrail: string[] = [];

    if (activeConfig) {
      try {
        activeClient = activeConfig.getGeminiClient?.();
        debugTrail.push(`step1=${activeClient ? 'gotClient' : 'nullClient'}`);
      } catch (e: any) {
        initErrorMsg = e.message || String(e);
        debugTrail.push(`step1=threw:${initErrorMsg.slice(0, 80)}`);
        dwarn(`[Feishu] getGeminiClient threw: ${initErrorMsg}`);
      }

      // 🚀 关键：CLI 启动延迟认证策略 — 用户首次在 TUI 发消息时才会 refreshAuth 初始化 geminiClient。
      // 但飞书这边并不会等用户在 TUI 发消息，所以我们必须在这里主动 lazy 触发首次认证刷新，
      // 拿到一个真正可用的 geminiClient 实例。
      if (!activeClient) {
        try {
          const settings = globalCommandContext?.services?.settings;
          const authType = settings?.merged?.selectedAuthType || AuthType.USE_PROXY_AUTH;
          debugTrail.push(`step2=lazyRefreshAuth(${authType})`);
          dlog(`[Feishu] geminiClient is not initialized. Triggering lazy refreshAuth(${authType})...`);
          await activeConfig.refreshAuth(authType);
          activeClient = activeConfig.getGeminiClient?.();
          debugTrail.push(`step3=${activeClient ? 'lazyOk' : 'lazyStillNull'}`);
          if (activeClient) {
            dlog(`[Feishu] Lazy refreshAuth succeeded; geminiClient is ready.`);
            initErrorMsg = '';
          }
        } catch (e: any) {
          initErrorMsg = `Lazy refreshAuth failed: ${e.message || String(e)}`;
          debugTrail.push(`step2=threw:${(e.message || String(e)).slice(0, 80)}`);
          dwarn(`[Feishu] ${initErrorMsg}`);
        }
      }
    } else {
      debugTrail.push(`step0=noActiveConfig`);
    }

    // 🎯 1. 实时更新当前会话上下文辅助数据（供 session 隔离下的工具调用读取最新状态）
    chatLastMessageId.set(msg.chatId, msg.messageId);
    activeSenderOpenIds.set(msg.chatId, msg.senderOpenId);

    // 🚀 多项目路由环境拦截
    const routes = await loadProjectRoutes();
    const route = routes[msg.chatId];

    // 如果当前是群聊消息，且完全没有绑定任何本地项目，提示绑定并拦截
    if (msg.chatType === 'group' && (!route || !route.projectRoot)) {
      const bindTip = `⏳ **本飞书群尚未绑定任何本地项目工作区。**\n\n` +
        `请群管理员或 Bot 拥有者在此群发送：\n` +
        `  \`/bind <您本地项目的绝对路径>\`\n` +
        `*(例如：\`/bind D:\\projects\\my-great-app\`)*\n\n` +
        `绑定成功后，我将在此专属群里为您提供该项目的 AI 远程控制和代码读写服务！\n\n` +
        `💡 **提示**: 您也可以在单聊私信中，直接对我说：“创建一个新项目 工作目录是 d:\\123”，让我为您自动建群并绑定工作区哦！`;
      await gateway.sendMessage(msg.chatId, bindTip, msg.messageId);
      return null;
    }

    // 🚀 确保每一笔会话（私聊或绑定的群聊）都具有完整、彻底隔离的环境！
    let session = isolatedSessions.get(msg.chatId);
    let currentConfig = activeConfig;
    let currentClient = activeClient;

    if (!session) {
      // 决定此会话的目标工作区路径
      const workspaceRoot = (route && route.projectRoot)
        ? route.projectRoot
        : ((typeof activeConfig?.getProjectRoot === 'function' && activeConfig.getProjectRoot()) || process.cwd());

      // 🔍 打印实时调试诊断信息到 TUI 大厅，以便看清到底解析到了哪个 chatId 和工作目录
      tuiContext?.addItem({
        type: 'info',
        text: `🔍 [Router] 收到来自 Chat ID \`${msg.chatId}\` 的消息，解析工作目录为: \`${workspaceRoot}\` (绑定路由: ${route ? '有' : '无'})`
      }, Date.now());

      dlog(`[Router] Instantiating isolated environment for chatId '${msg.chatId}' on root '${workspaceRoot}'`);
      const isolatedConfig = new Config({
        sessionId: `feishu-${msg.chatId}-${Date.now()}`,
        cwd: workspaceRoot,
        debugMode: config?.getDebugMode() || false,
        targetDir: workspaceRoot,
      });

      try {
        // 🚀 关键：必须先对全新的 Config 实例执行 initialize()，否则内部的 toolRegistry、
        // hookSystem 等核心组件不会被构建，导致 refreshAuth 抛错或 fallback 回主环境，
        // 从而引发“群聊工作目录依旧是 D:\projects\deepVcode\DeepCode”的安全状态漂移 Bug。
        dlog(`[Router] Initializing isolatedConfig on '${workspaceRoot}'...`);
        await isolatedConfig.initialize();

        // 主动 refreshAuth 初始化 GeminiClient
        const settings = globalCommandContext?.services?.settings;
        const isolatedAuthType = settings?.merged?.selectedAuthType || AuthType.USE_PROXY_AUTH;
        dlog(`[Router] Calling refreshAuth(${isolatedAuthType}) on isolatedConfig...`);
        await isolatedConfig.refreshAuth(isolatedAuthType);
        const isolatedClient = isolatedConfig.getGeminiClient();
        if (!isolatedClient) {
          throw new Error('refreshAuth completed but isolatedConfig.getGeminiClient() still returns null/undefined.');
        }

        // 🎯 在此会话特定的 toolRegistry 中，专属且精确注册飞书工具，绝不污染或错乱其他群的消息卡片
        const toolRegistry = await isolatedConfig.getToolRegistry();

        // 注册专属于此 chatId 的文件发送工具，彻底杜绝多群并发时发送文件发错群的问题
        toolRegistry.registerTool(new SendFeishuFileTool(
          gateway,
          () => msg.chatId,
          () => chatLastMessageId.get(msg.chatId),
          () => workspaceRoot,
        ));

        // 注册专属于此 chatId 的建群工具
        toolRegistry.registerTool(new CreateProjectGroupTool(
          gateway,
          () => activeSenderOpenIds.get(msg.chatId),
          async (newChatId, path) => {
            await saveProjectRoute(newChatId, { projectRoot: path });
          }
        ));

        await isolatedClient.setTools();
        dlog(`[Router] Successfully registered session-specific tools for '${msg.chatId}'`);

        session = { config: isolatedConfig, geminiClient: isolatedClient };
        isolatedSessions.set(msg.chatId, session);
        debugTrail.push(`isolatedReady`);
      } catch (e: any) {
        initErrorMsg = `Isolated session init failed: ${e.message || String(e)}`;
        debugTrail.push(`isolatedFail:${(e.message || String(e)).slice(0, 80)}`);
        dwarn(`[Router] Failed to init isolated session: ${initErrorMsg}`);
        // 回退
        if (activeConfig && activeClient) {
          session = { config: activeConfig, geminiClient: activeClient };
        }
      }
    } else {
      debugTrail.push(`isolatedCached`);
    }

    if (session) {
      currentConfig = session.config;
      currentClient = session.geminiClient;
    }

    // 2. 获取或创建 Chat 专属队列并排队
    let queue = messageQueues.get(msg.chatId);
    if (!queue) {
      queue = [];
      messageQueues.set(msg.chatId, queue);
    }
    const isProcessing = isProcessingQueues.get(msg.chatId) || false;

    if (isProcessing || queue.length > 0) {
      const queuePosition = queue.length + 1;
      const queueTip = `⏳ *当前项目任务正在执行中，您的新请求已放入项目队列排队（当前排在第 ${queuePosition} 位）...*`;
      await gateway.sendMessage(msg.chatId, queueTip, msg.messageId);
    }

    return new Promise<string | null>((resolve, reject) => {
      queue!.push({ msg, resolve, reject });
      const richErr = initErrorMsg || (debugTrail.length ? `trail=[${debugTrail.join('|')}]` : '');
      processMessageQueueForChat(gateway, currentConfig, currentClient, creds, msg.chatId, richErr);
    });
  };

  async function handleSingleFeishuMessage(
    msg: FeishuMessage,
    gateway: FeishuGateway,
    config: any,
    geminiClient: any,
    creds: FeishuCredentials,
    initErrorMsg?: string,
  ): Promise<string | null> {
    const messageText = typeof msg.text === 'string' ? msg.text.trim() : '';

    // 🎯 保存当前会话上下文（供 send_feishu_file 工具使用）
    activeChatId = msg.chatId;
    activeReplyToMessageId = msg.messageId;

    // 同步显示飞书消息到 TUI (格式规范化：[feishu_chatId][sender:openId])
    const prefix = `[feishu_${msg.chatId}][sender:${msg.senderOpenId}] `;
    tuiContext?.addItem(
      { type: 'user', text: `${prefix}${messageText}` },
      Date.now(),
    );

    // 拦截斜杠命令（/new, /compress, /help 等），不发给 LLM
    if (messageText.startsWith('/')) {
      const cmdResult = await handleFeishuCommand(messageText, geminiClient, config);
      if (cmdResult !== null) {
        tuiContext?.addItem({ type: 'info', text: cmdResult }, Date.now());
        return cmdResult;
      }
      // 未知斜杠命令 — 提示可用命令，不要当普通消息发给 LLM（避免 LLM 幻觉回复）
      if (!FEISHU_SLASH_COMMANDS[messageText.split(/\s+/)[0].toLowerCase()]) {
        const hint = `❓ 未知命令: ${messageText.split(/\s+/)[0]}\n\n输入 /help 查看可用命令`;
        tuiContext?.addItem({ type: 'info', text: hint }, Date.now());
        return hint;
      }
    }

    if (!geminiClient || !config) {
      const errorDetail = initErrorMsg ? `\n\n📌 **底层初始化失败原因**: \`${initErrorMsg}\`` : '';
      // 🔬 DEBUG: 打印更多状态信息便于排查
      const debugInfo = `[hasConfig=${!!config}, hasClient=${!!geminiClient}, hasGlobalCtx=${!!globalCommandContext}, hasGlobalCfg=${!!globalCommandContext?.services?.config}]`;
      const noLlmReply = `⚠️ **LLM 未初始化，无法回答。**${errorDetail}\n\n🔬 **调试信息**: \`${debugInfo}\`` +
        '\n\n💡 **提示**: 请在 dvcode TUI 大厅里先发送一条消息（例如「hi」）让认证流程完整初始化，然后再回到飞书重试。';
      tuiContext?.addItem({ type: 'info', text: noLlmReply }, Date.now());
      return noLlmReply;
    }

    const toolRegistry: ToolRegistry = await config.getToolRegistry();
    const abortController = new AbortController();
    activeAbortControllers.set(msg.chatId, abortController);
    const promptId = `feishu-${Date.now()}`;

    let activeCardId: string | null = null;
    let accumulatedMarkdown = '';

    try {
      // 确保 chat 已初始化
      await geminiClient.waitForChatInitialized();

      // Agent 循环：和 TUI 共享同一个会话，走 geminiClient.sendMessageStream
      let currentMessage: PartListUnion = messageText;

      // 🎨 完美多模态对齐：检测输入消息中是否带有由飞书网关自动下载的本地图片标记 ![image](path)
      // 如果存在，我们将该图片读取为 Base64 并构造成 Gemini 兼容的多模态 `inlineData` Part 共同投喂！
      const imageMatch = messageText.match(/!\[image\]\(([^)]+)\)/);
      if (imageMatch) {
        const localImagePath = imageMatch[1];
        try {
          if (fs.existsSync(localImagePath)) {
            const ext = path.extname(localImagePath).toLowerCase();
            const mimeType = ext === '.png' ? 'image/png' :
                             ext === '.gif' ? 'image/gif' :
                             ext === '.webp' ? 'image/webp' : 'image/jpeg';
            const base64Data = fs.readFileSync(localImagePath).toString('base64');
            const strippedText = messageText.replace(/!\[image\]\([^)]+\)/g, '').trim();

            currentMessage = [
              { inlineData: { mimeType, data: base64Data } },
              { text: strippedText || '请帮我阅读分析这张图片。' }
            ];
            dlog(`[Feishu] Multimodal image part successfully constructed from: ${localImagePath}`);
          }
        } catch (e: any) {
          dwarn(`[Feishu] Failed to convert local image to inlineData: ${e?.message || e}`);
        }
      }

      const MAX_TURNS = 100;

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const stream = geminiClient.sendMessageStream(
          currentMessage,
          abortController.signal,
          promptId,
        );

        let responseText = '';
        let lastUpdateTime = 0;
        const MIN_UPDATE_INTERVAL = 1500; // 节流控制，1.5 秒更新一次
        const toolCallRequests: ToolCallRequestInfo[] = [];

        for await (const event of stream) {
          switch (event.type) {
            case GeminiEventType.Content: {
              responseText += event.value;
              // 确保两笔输出之间有安全的换行，避免大模型文本直接粘连在代码块的闭合标记 ``` 后面
              let separator = '';
              if (accumulatedMarkdown && !accumulatedMarkdown.endsWith('\n\n')) {
                separator = accumulatedMarkdown.endsWith('\n') ? '\n' : '\n\n';
              }
              const currentTotalMarkdown = accumulatedMarkdown + separator + responseText;
              const trimmed = currentTotalMarkdown.trim();
              if (trimmed) {
                const now = Date.now();
                if (!activeCardId) {
                  // 第一次发送，获取卡片消息 ID
                  activeCardId = await gateway.sendCard(
                    msg.chatId,
                    'DeepV Code AI 助理',
                    trimmed,
                    [],
                    msg.messageId,
                  );
                  lastUpdateTime = now;
                } else if (now - lastUpdateTime >= MIN_UPDATE_INTERVAL) {
                  await gateway.updateCard(activeCardId, 'DeepV Code AI 助理', trimmed);
                  lastUpdateTime = now;
                }
              }
              break;
            }
            case GeminiEventType.ToolCallRequest:
              toolCallRequests.push(event.value);
              break;
            case GeminiEventType.ChatCompressed:
              tuiContext?.addItem({ type: 'info', text: t('feishu.tui.context_compressed') }, Date.now());
              break;
            case GeminiEventType.Error:
              throw new Error(event.value?.error?.message || 'unknown error');
          }
        }

        // 把当前这轮回复合并进累计 Markdown 中
        if (accumulatedMarkdown && responseText) {
          const separator = accumulatedMarkdown.endsWith('\n\n') ? '' : (accumulatedMarkdown.endsWith('\n') ? '\n' : '\n\n');
          accumulatedMarkdown += separator + responseText;
        } else if (responseText) {
          accumulatedMarkdown += responseText;
        }

        // 结束流式输出，做最终的、无中间提示的更新
        if (activeCardId) {
          const success = await safeUpdateCardWithRetry(gateway, activeCardId, 'DeepV Code AI 助理', accumulatedMarkdown || '（无回复）');
          if (!success) {
            dwarn('[Feishu Stream] Failed to update final card with retry. Fallback to sending new card.');
            activeCardId = await gateway.sendCard(
              msg.chatId,
              'DeepV Code AI 助理',
              accumulatedMarkdown || '（无回复）',
              [],
              msg.messageId,
            );
          }
        }

        // 无工具调用 → 最终回复
        if (toolCallRequests.length === 0) {
          const replyText = responseText || '（无回复）';
          tuiContext?.addItem({ type: 'gemini', text: replyText }, Date.now());

          // 兜底：如果有些特别快的一轮或者流中由于某种原因没有触发 activeCardId 却有最终回复
          if (!activeCardId) {
            activeCardId = await gateway.sendCard(
              msg.chatId,
              'DeepV Code AI 助理',
              accumulatedMarkdown || '（无回复）',
              [],
              msg.messageId,
            );
          }

          // 检测并发送文件（沙箱化到 projectRoot，扩展名白名单）
          const projectRoot: string =
            (typeof config?.getProjectRoot === 'function' && config.getProjectRoot()) ||
            process.cwd();
          await sendDetectedFiles(
            gateway,
            msg.chatId,
            msg.messageId,
            replyText,
            projectRoot,
          );
          return null; // 自己已发送，不触发 gateway 自动回复
        }

        // 有工具执行
        const toolNames = toolCallRequests.map(r => r.name || 'unknown').join(', ');
        tuiContext?.addItem(
          { type: 'info', text: tp('feishu.tui.tool_running', { names: toolNames }) },
          Date.now(),
        );

        // 发送/更新工具运行进度通知给飞书卡片
        const toolRunningText = `\n\n*(🔧 正在运行工具: ${toolNames}...)*`;
        if (activeCardId) {
          await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (运行工具中)', accumulatedMarkdown + toolRunningText);
        } else {
          activeCardId = await gateway.sendCard(
            msg.chatId,
            'DeepV Code AI 助理 (运行工具中)',
            toolRunningText,
            [],
            msg.messageId,
          );
        }

        // 执行工具调用，收集 functionResponse
        const toolResponseParts: Part[] = [];
        for (const req of toolCallRequests) {
          const toolName = req.name || 'unknown';
          const toolArgsDesc = req.args ? JSON.stringify(req.args).slice(0, 100) : '';
          tuiContext?.addItem(
            { type: 'info', text: tp('feishu.tui.tool_running_with_args', { name: toolName, args: toolArgsDesc }) },
            Date.now(),
          );

          try {
            // 🎯 飞书模式：拦截 ask_user_question，用交互卡片让用户回答
            if (toolName === 'ask_user_question' && req.args) {
              const cardResult = await handleAskUserQuestionViaCard(
                gateway,
                msg.chatId,
                msg.messageId,
                req.args as any,
                req.callId,
              );
              toolResponseParts.push(cardResult);
              tuiContext?.addItem(
                { type: 'info', text: t('feishu.tui.tool_user_answered') },
                Date.now(),
              );
              continue;
            }

            let toolResponse;
            if (toolName === 'run_shell_command') {
              // 精细捕获 run_shell_command 的滚动输出！
              const shellTool = toolRegistry.getTool('run_shell_command');
              if (shellTool) {
                const startTime = Date.now();
                let lastCardUpdateTime = 0;
                const CARD_UPDATE_THROTTLE_MS = 1500;

                const toolResult = await shellTool.execute(
                  req.args,
                  abortController.signal,
                  async (output) => {
                    const now = Date.now();
                    // 节流更新飞书卡片上的控制台滚动输出
                    if (activeCardId && now - lastCardUpdateTime >= CARD_UPDATE_THROTTLE_MS) {
                      const liveProgressMarkdown = formatToolCallWithBorder('run_shell_command', req.args, true, output, true);
                      await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (执行命令中)', accumulatedMarkdown + '\n\n' + liveProgressMarkdown);
                      lastCardUpdateTime = now;
                    }
                  }
                );

                // 将 toolResult 转换为标准的 ToolCallResponseInfo 格式
                const durationMs = Date.now() - startTime;
                const responseLength = typeof toolResult.llmContent === 'string'
                  ? toolResult.llmContent.length
                  : JSON.stringify(toolResult.llmContent).length;

                // 核心的 telemetry 日志
                config?.getTelemetry?.()?.logToolCall?.(config, {
                  'event.name': 'tool_call',
                  'event.timestamp': new Date().toISOString(),
                  function_name: 'run_shell_command',
                  function_args: req.args,
                  duration_ms: durationMs,
                  success: true,
                  prompt_id: req.prompt_id,
                  response_length: responseLength,
                });

                const response = {
                  functionResponse: {
                    id: req.callId,
                    name: 'run_shell_command',
                    response: { output: toolResult.llmContent },
                  }
                };

                toolResponse = {
                  callId: req.callId,
                  responseParts: [response],
                  resultDisplay: toolResult.returnDisplay,
                };
              } else {
                // 降级使用常规 executeToolCall
                toolResponse = await executeToolCall(config, req, toolRegistry, abortController.signal);
              }
            } else {
              // 其它非 Shell 工具，直接通过 executeToolCall 执行
              // 在开始执行前，向飞书卡片展示该工具的进行中状态 (⏳)
              const liveToolProgress = formatToolCallWithBorder(toolName, req.args, true, '', true);
              if (activeCardId) {
                await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (执行工具中)', accumulatedMarkdown + '\n\n' + liveToolProgress);
              }
              toolResponse = await executeToolCall(config, req, toolRegistry, abortController.signal);
            }

            if (toolResponse.responseParts) {
              const parts = Array.isArray(toolResponse.responseParts) ? toolResponse.responseParts : [toolResponse.responseParts];
              toolResponseParts.push(...(parts as Part[]));
            }

            // 在 accumulatedMarkdown 后面追加当前工具的最终精美运行报告
            const finalDisplayOutput = typeof toolResponse.resultDisplay === 'string'
              ? toolResponse.resultDisplay
              : JSON.stringify(toolResponse.resultDisplay, null, 2);

            const toolReportMarkdown = formatToolCallWithBorder(toolName, req.args, true, finalDisplayOutput, false);

            // 拼接进大卡片的 markdown
            accumulatedMarkdown += `\n\n${toolReportMarkdown}`;

            // 最终无打字机光标的连贯卡片更新
            if (activeCardId) {
              await safeUpdateCardWithRetry(gateway, activeCardId, 'DeepV Code AI 助理', accumulatedMarkdown);
            }

            tuiContext?.addItem(
              { type: 'info', text: tp('feishu.tui.tool_done', { name: toolName }) },
              Date.now(),
            );
          } catch (toolErr: any) {
            // 工具执行失败追加精美样式
            const failedReportMarkdown = formatToolCallWithBorder(toolName, req.args, false, toolErr.message || '未知错误', false);
            accumulatedMarkdown += `\n\n${failedReportMarkdown}`;
            if (activeCardId) {
              await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (执行失败)', accumulatedMarkdown);
            }

            tuiContext?.addItem(
              { type: 'error', text: tp('feishu.tui.tool_failed', { name: toolName, error: toolErr.message }) },
              Date.now(),
            );
            throw toolErr;
          }
        }

        // 工具执行结束，更新状态
        if (activeCardId) {
          await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (思考中)', accumulatedMarkdown + `\n\n*(🧠 AI 正在结合工具结果继续思考...)*`);
        }

        // 将工具结果作为下一轮输入
        currentMessage = toolResponseParts;
      }

      // 达到最大轮数
      if (activeCardId) {
        await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (已中断)', accumulatedMarkdown + '\n\n*（工具调用次数已达到上限）*');
      } else {
        await gateway.sendMessage(msg.chatId, '（工具调用次数已达到上限）', msg.messageId);
      }
      return null;
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('aborted') || err.message?.includes('canceled') || err.message?.includes('cancelled')) {
        if (activeCardId) {
          await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (已中止)', accumulatedMarkdown + '\n\n*🛑 任务已被用户中止。*');
        }
        return null;
      }
      derror('Feishu Agent processing error:', err.message);
      const errorReply = `❌ 处理消息时出错: ${err.message}`;
      tuiContext?.addItem(
        { type: 'error', text: tp('feishu.tui.processing_error', { error: err.message }) },
        Date.now(),
      );
      return errorReply;
    } finally {
      activeAbortControllers.delete(msg.chatId);
    }
  }

  async function safeUpdateCardWithRetry(
    gateway: FeishuGateway,
    messageId: string,
    title: string,
    content: string,
    retries = 3,
    delayMs = 1000
  ): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const success = await gateway.updateCard(messageId, title, content);
      if (success) {
        return true;
      }
      dlog(`[Feishu Card Stream] Update failed, retrying ${i + 1}/${retries} in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return false;
  }

  function getLatest20Lines(text: string): string {
    if (!text) return '';
    const lines = text.split('\n');
    if (lines.length > 20) {
      return lines.slice(-20).join('\n');
    }
    return text;
  }

  function getToolShortName(name: string): string {
    switch (name) {
      case 'run_shell_command': return 'Shell';
      case 'read_file': return 'ReadFile';
      case 'read_many_files': return 'ReadManyFiles';
      case 'write_file': return 'WriteFile';
      case 'delete_file': return 'DeleteFile';
      case 'replace': return 'Replace';
      case 'glob': return 'Glob';
      case 'grep': return 'Grep';
      case 'search_file_content': return 'SearchContent';
      case 'web_search': return 'WebSearch';
      case 'web_fetch': return 'WebFetch';
      case 'todo_write': return 'TodoWrite';
      case 'task': return 'SubAgentTask';
      case 'use_skill': return 'UseSkill';
      default: {
        return name.split(/[-_]+/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
      }
    }
  }

  function formatToolCallWithBorder(
    toolName: string,
    args: any,
    success: boolean,
    output: string,
    isLive = false
  ): string {
    const shortName = getToolShortName(toolName);
    const statusIcon = success ? '✅️' : '❌';
    const liveStatusIcon = isLive ? '⏳' : statusIcon;

    // 1. 提取参数主信息
    let mainArg = '';
    const keys = Object.keys(args || {});
    if (toolName === 'run_shell_command' && args.command) {
      mainArg = args.command;
    } else if ((toolName === 'read_file' || toolName === 'write_file') && args.absolute_path) {
      mainArg = args.absolute_path;
    } else if (toolName === 'replace' && args.file_path) {
      mainArg = args.file_path;
    } else if (args.path) {
      mainArg = args.path;
    } else if (args.pattern) {
      mainArg = args.pattern;
    } else if (keys.length > 0) {
      mainArg = String(args[keys[0]]);
    }

    // 缩短绝对路径到相对路径（看起来更整洁）
    if (mainArg && mainArg.includes('DeepCode')) {
      const parts = mainArg.split(/[\\/]DeepCode[\\/]/);
      if (parts.length > 1) {
        mainArg = parts[1];
      }
    }

    // 2. 提取 description (很多大模型会在工具调用里附带 description)
    const descriptionStr = args.description ? ` (${args.description})` : '';

    // 3. 构建第一行头部
    const headLine = `${liveStatusIcon} **${shortName}** \`${mainArg}\`${descriptionStr}`;

    // 4. 构建树形分支及输出内容
    let branchLine = '';
    let contentBox = '';

    if (toolName === 'run_shell_command') {
      const rawOutput = output || '';
      const lines = rawOutput.split('\n');
      const totalLines = lines.length;
      // 取最后 15 行
      const maxLinesToShow = 15;
      let displayedLines = lines;
      if (lines.length > maxLinesToShow) {
        displayedLines = lines.slice(-maxLinesToShow);
      }

      branchLine = `\n └ ... (showing last ${displayedLines.length} lines, ${totalLines} lines total)`;

      // 直接使用飞书原生支持的最美观且自适应等宽的代码框组件，确保在任何端上绝不乱行
      contentBox = `\n\`\`\`bash\n${displayedLines.join('\n')}\n\`\`\``;
    } else if (toolName === 'read_file') {
      const startLine = args.offset !== undefined ? args.offset + 1 : 1;
      const limit = args.limit !== undefined ? args.limit : 'all';
      branchLine = `\n └ ( read lines: ${startLine}-${limit === 'all' ? 'end' : startLine + Number(limit) - 1} )`;
    } else if (toolName === 'replace') {
      branchLine = `\n └ ( apply replacements completed )`;
    } else if (toolName === 'write_file') {
      branchLine = `\n └ ( file write completed )`;
    } else {
      const summary = output ? (output.length > 100 ? output.slice(0, 100) + '...' : output) : 'success';
      branchLine = `\n └ ( ${summary.replace(/\n/g, ' ')} )`;
    }

    return `${headLine}${branchLine}${contentBox}`;
  }

  async function processMessageQueueForChat(
    gateway: FeishuGateway,
    config: any,
    geminiClient: any,
    creds: FeishuCredentials,
    chatId: string,
    initErrorMsg?: string
  ) {
    if (isProcessingQueues.get(chatId)) return;
    isProcessingQueues.set(chatId, true);

    try {
      const queue = messageQueues.get(chatId);
      while (queue && queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;

        const { msg, resolve, reject } = item;
        try {
          const result = await handleSingleFeishuMessage(msg, gateway, config, geminiClient, creds, initErrorMsg);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }
    } finally {
      isProcessingQueues.set(chatId, false);
    }
  }

  gateway.onReady = () => {
    dlog('Feishu Bot ready');
  };

  gateway.onDisconnect = () => {
    dlog('Feishu connection closed');
  };

  try {
    await gateway.connect();
    activeGateway = gateway;

    // 🎯 动态注册 send_feishu_file 工具，让 Agent 可以直接发送文件到飞书
    if (config && geminiClient) {
      try {
        const toolRegistry: ToolRegistry = await config.getToolRegistry();
        const projectRoot: string =
          (typeof config.getProjectRoot === 'function' && config.getProjectRoot()) ||
          process.cwd();
        toolRegistry.registerTool(new SendFeishuFileTool(
          gateway,
          () => activeChatId ?? undefined,
          () => activeReplyToMessageId ?? undefined,
          () => projectRoot,
        ));

        // 🎯 动态注册自动建群及多项目隔离管理工具：create_project_and_group_chat
        toolRegistry.registerTool(new CreateProjectGroupTool(
          gateway,
          () => activeSenderOpenId ?? undefined,
          async (chatId, path) => {
            await saveProjectRoute(chatId, { projectRoot: path });
          }
        ));

        await geminiClient.setTools();
        dlog('Registered Feishu file-send tool and group-chat tool successfully.');
      } catch (toolErr: any) {
        dwarn('Failed to register Feishu tool (continuing):', toolErr.message);
      }
    }

    const platform = creds.domain === 'lark'
      ? t('feishu.start.platform.lark')
      : t('feishu.start.platform.feishu');
    return [
      t('feishu.start.success_title'),
      tp('feishu.start.success_bot', { name: creds.botName || t('feishu.start.bot_unknown') }),
      tp('feishu.start.success_platform', { platform }),
      '',
      t('feishu.start.success_hint_chat'),
      t('feishu.start.success_hint_stop'),
    ].join('\n');
  } catch (err: any) {
    return tp('feishu.start.failed', { error: err.message });
  }
}

/**
 * 停止网关
 */
async function handleStop(context?: CommandContext): Promise<string> {
  if (!activeGateway) {
    return t('feishu.stop.not_running');
  }

  // 🎯 动态注销 send_feishu_file 及 create_project_and_group_chat 工具
  const config = context?.services?.config;
  const geminiClient = config?.getGeminiClient?.();
  if (config && geminiClient) {
    try {
      const toolRegistry: ToolRegistry = await config.getToolRegistry();
      const removed = toolRegistry.unregisterTool(SendFeishuFileTool.Name);
      const removedGroupTool = toolRegistry.unregisterTool(CreateProjectGroupTool.Name);
      if (removed || removedGroupTool) {
        await geminiClient.setTools();
        dlog('Unregistered Feishu file-send and group-chat tools successfully.');
      }
    } catch (toolErr: any) {
      dwarn('Failed to unregister Feishu tool:', toolErr.message);
    }
  }

  clearMessageQueue();

  await activeGateway.disconnect();
  activeGateway = null;
  tuiContext = null; // 清除 TUI 上下文
  globalCommandContext = null;
  activeChatId = null;
  activeReplyToMessageId = null;
  return t('feishu.stop.stopped');
}

/**
 * 查看状态
 */
async function handleStatus(): Promise<string> {
  const result = await loadCredsSafe();
  if (!result.ok) {
    return tp('feishu.start.creds_load_failed', { error: result.error });
  }
  const creds = result.creds;
  const lines: string[] = [t('feishu.status.title')];

  if (creds) {
    lines.push(t('feishu.status.creds_configured'));
    lines.push(`  App ID:      ${creds.appId}`);
    lines.push(tp('feishu.status.bot_name', { name: creds.botName || t('feishu.start.bot_unknown') }));
    const platform = creds.domain === 'lark'
      ? t('feishu.start.platform.lark')
      : t('feishu.start.platform.feishu');
    lines.push(tp('feishu.status.platform', { platform }));
    lines.push(tp('feishu.status.owner', {
      owner: creds.ownerOpenId || t('feishu.status.owner_unbound'),
    }));
    if (creds.allowlist && creds.allowlist.length > 0) {
      lines.push(tp('feishu.status.allowlist_count', { count: creds.allowlist.length }));
    }
  } else {
    lines.push(t('feishu.status.creds_missing'));
    lines.push('');
    lines.push(t('feishu.status.run_setup'));
    return lines.join('\n');
  }

  const status = activeGateway
    ? t('feishu.status.bot_status_running')
    : t('feishu.status.bot_status_stopped');
  lines.push(tp('feishu.status.bot_status_label', { status }));

  // ✨ Mini-doctor：检测 scope 健康度，给出修复建议
  try {
    const probe = await probeCredentials(creds.appId, creds.appSecret, creds.domain);
    if (probe?.grantedScopes) {
      const missing = computeMissingScopes(probe.grantedScopes, [...REQUIRED_APP_SCOPES]);
      lines.push('');
      if (missing.length === 0) {
        lines.push('  ✅ 应用权限：已开通全部 dvcode 必需的 scope');
      } else {
        const applyUrl = buildScopeApplyUrl({
          appId: creds.appId,
          scopes: missing,
          brand: creds.domain,
          tokenType: 'tenant',
        });
        lines.push(`  ⚠️ 应用权限：缺失 ${missing.length} 项必需 scope`);
        lines.push(`     一键申请：${applyUrl}`);
        if (missing.length <= 8) {
          for (const s of missing) lines.push(`       - ${s}`);
        }
      }

      // 检测「群免 @」敏感权限是否已开
      const hasGroupMsgScope = probe.grantedScopes.includes(SENSITIVE_GROUP_MSG_SCOPE);
      lines.push('');
      if (hasGroupMsgScope) {
        lines.push('  ✅ 群消息免 @：已开通（群里所有消息都会推送给 bot）');
      } else {
        const sensitiveUrl = buildScopeApplyUrl({
          appId: creds.appId,
          scopes: [SENSITIVE_GROUP_MSG_SCOPE],
          brand: creds.domain,
          tokenType: 'tenant',
        });
        lines.push('  ℹ️ 群消息免 @：未开通（群里仅 @bot 才响应）');
        lines.push(`     如需"无需 @ 直接响应"功能，申请敏感权限：${sensitiveUrl}`);
      }
    } else {
      // 应用还没开通 application:application:self_manage，无法 probe scope
      lines.push('');
      lines.push('  ℹ️ 无法读取应用 scope 列表（应用尚未开通 `application:application:self_manage`）');
      lines.push(`     一键申请所有必需 scope：${buildScopeApplyUrl({
        appId: creds.appId,
        scopes: [...REQUIRED_APP_SCOPES],
        brand: creds.domain,
        tokenType: 'tenant',
      })}`);
    }
  } catch {
    /* probe 失败不阻塞 status 输出 */
  }

  if (!activeGateway) {
    lines.push('');
    lines.push(t('feishu.status.run_start'));
  }

  return lines.join('\n');
}

/**
 * 添加 open_id 到授权白名单（B1 — 授权管理）
 *
 * 用法：/feishu allow <openId>
 */
async function handleAllow(args: string): Promise<string> {
  const openId = args.trim();
  if (!openId) {
    return [
      t('feishu.allow.usage_title'),
      '',
      t('feishu.allow.usage_body'),
      t('feishu.allow.usage_where'),
    ].join('\n');
  }
  let creds: FeishuCredentials | null;
  try {
    creds = await loadCredentials();
  } catch (e) {
    return tp('feishu.allow.creds_load_failed', { error: (e as Error).message });
  }
  if (!creds) {
    return t('feishu.allow.creds_missing');
  }
  // owner 已是该 openId 时无需再加
  if (creds.ownerOpenId === openId) {
    return tp('feishu.allow.already_owner', { openId });
  }
  // 如果 owner 未绑定，把这个 openId 设为 owner
  if (!creds.ownerOpenId) {
    creds.ownerOpenId = openId;
    await saveCredentials(creds);
    return tp('feishu.allow.set_as_owner', { openId });
  }
  const list = new Set(creds.allowlist ?? []);
  if (list.has(openId)) {
    return tp('feishu.allow.already_in_list', { openId });
  }
  list.add(openId);
  creds.allowlist = [...list];
  await saveCredentials(creds);
  return tp('feishu.allow.added', { openId, count: creds.allowlist.length });
}

/**
 * 从授权白名单移除 open_id（B1 — 授权管理）
 *
 * 用法：/feishu deny <openId>
 */
async function handleDeny(args: string): Promise<string> {
  const openId = args.trim();
  if (!openId) {
    return t('feishu.deny.usage');
  }
  let creds: FeishuCredentials | null;
  try {
    creds = await loadCredentials();
  } catch (e) {
    return tp('feishu.allow.creds_load_failed', { error: (e as Error).message });
  }
  if (!creds) {
    return t('feishu.allow.creds_missing');
  }
  if (creds.ownerOpenId === openId) {
    return tp('feishu.deny.cannot_remove_owner', { openId });
  }
  const before = creds.allowlist?.length ?? 0;
  creds.allowlist = (creds.allowlist ?? []).filter((id) => id !== openId);
  if (creds.allowlist.length === before) {
    return tp('feishu.deny.not_in_list', { openId });
  }
  await saveCredentials(creds);
  return tp('feishu.deny.removed', { openId, count: creds.allowlist.length });
}

/**
 * 列出授权白名单（B1 — 授权管理）
 */
async function handleAllowlist(): Promise<string> {
  let creds: FeishuCredentials | null;
  try {
    creds = await loadCredentials();
  } catch (e) {
    return tp('feishu.allow.creds_load_failed', { error: (e as Error).message });
  }
  if (!creds) {
    return t('feishu.allow.creds_missing');
  }
  const lines = [t('feishu.allowlist.title')];
  lines.push(tp('feishu.allowlist.owner', {
    owner: creds.ownerOpenId || t('feishu.allowlist.owner_unbound'),
  }));
  if (creds.allowlist && creds.allowlist.length > 0) {
    lines.push(t('feishu.allowlist.list_header'));
    for (const id of creds.allowlist) {
      lines.push(`    - ${id}`);
    }
  } else {
    lines.push(t('feishu.allowlist.list_empty'));
  }
  lines.push('');
  lines.push(t('feishu.allowlist.manage_hint'));
  return lines.join('\n');
}

/**
 * 清除凭证
 */
async function handleLogout(context?: CommandContext): Promise<string> {
  if (activeGateway) {
    // 🎯 注销飞书工具
    const config = context?.services?.config;
    const geminiClient = config?.getGeminiClient?.();
    if (config && geminiClient) {
      try {
        const toolRegistry: ToolRegistry = await config.getToolRegistry();
        toolRegistry.unregisterTool(SendFeishuFileTool.Name);
        await geminiClient.setTools();
      } catch {
        // ignore
      }
    }
    await activeGateway.disconnect();
    activeGateway = null;
  }
  tuiContext = null; // 清除 TUI 上下文
  activeChatId = null;
  activeReplyToMessageId = null;
  await clearCredentials();
  return t('feishu.logout.cleared');
}

/**
 * 交互式主入口
 */
async function handleInteractive(): Promise<string> {
  const result = await loadCredsSafe();
  if (!result.ok) {
    return tp('feishu.start.creds_load_failed', { error: result.error });
  }
  const creds = result.creds;

  if (!creds) {
    // 未配置，引导 setup
    return [
      t('feishu.interactive.welcome'),
      '',
      t('feishu.interactive.first_time'),
      t('feishu.interactive.setup_qr'),
      t('feishu.interactive.setup_manual'),
      '',
      t('feishu.interactive.help_hint'),
    ].join('\n');
  }

  if (!activeGateway) {
    return [
      t('feishu.interactive.creds_ready'),
      `  App ID: ${creds.appId}`,
      tp('feishu.interactive.creds_bot', { name: creds.botName || t('feishu.start.bot_unknown') }),
      '',
      t('feishu.interactive.start_hint'),
      t('feishu.interactive.logout_hint'),
    ].join('\n');
  }

  return t('feishu.interactive.already_running');
}

interface CreateProjectGroupParams {
  project_path: string;
  group_name: string;
}

class CreateProjectGroupTool extends BaseTool<CreateProjectGroupParams, ToolResult> {
  static readonly Name = 'create_project_and_group_chat';

  constructor(
    private readonly gateway: FeishuGateway,
    private readonly getSenderOpenId: () => string | undefined,
    private readonly onProjectCreated: (chatId: string, path: string) => Promise<void>
  ) {
    super(
      CreateProjectGroupTool.Name,
      'CreateProjectAndGroupChat',
      'Creates a new local directory and automatically creates a dedicated Feishu group chat for this project, inviting the current user and binding the workspace. Only available in direct/P2P chat.',
      Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          project_path: {
            type: Type.STRING,
            description: 'The absolute local physical path to create or bind, e.g. D:\\my-project'
          },
          group_name: {
            type: Type.STRING,
            description: 'The name for the newly created group chat'
          }
        },
        required: ['project_path', 'group_name']
      }
    );
  }

  async execute(params: CreateProjectGroupParams, signal: AbortSignal): Promise<ToolResult> {
    const senderOpenId = this.getSenderOpenId();
    if (!senderOpenId) {
      return {
        llmContent: 'Error: Cannot create group chat because the sender openId is unknown.',
        returnDisplay: 'Error: Sender unknown'
      };
    }

    try {
      const fs = await import('node:fs');
      const path = await import('node:path');

      // 1. 本地目录安全校检/自建
      const absPath = path.resolve(params.project_path);
      if (!fs.existsSync(absPath)) {
        fs.mkdirSync(absPath, { recursive: true });
        dlog(`[CreateProjectGroupTool] Created folder: ${absPath}`);
      }

      // 2. 飞书端调用建群并拉人
      const newChatId = await this.gateway.createGroupChat(params.group_name, senderOpenId);
      if (!newChatId) {
        return {
          llmContent: `Error: Feishu open platform failed to create group chat '${params.group_name}'.`,
          returnDisplay: 'Error creating Feishu chat'
        };
      }

      // 3. 触发持久化绑定路由
      await this.onProjectCreated(newChatId, absPath);

      // 4. 主动往新群发首条欢迎及就绪通知消息
      const welcomeMsg = `👋 您好！本群项目工作目录 \`${absPath}\` 已经成功就绪。现在您可以随时在这个专属项目群里直接提问，我将全力为您服务！`;
      await this.gateway.sendMessage(newChatId, welcomeMsg);

      // 🎯 5. 异步检测是否缺失 im:message.group_msg 权限，并在当前的私聊会话中进行提醒和卡片推送
      if (activeChatId) {
        const privateChatId = activeChatId;
        void (async () => {
          try {
            const probe = await probeCredentials(
              this.gateway.getAppId(),
              this.gateway.getAppSecret(),
              this.gateway.getDomain()
            );
            if (probe && (!probe.grantedScopes || !probe.grantedScopes.includes(SENSITIVE_GROUP_MSG_SCOPE))) {
              const applyUrl = buildScopeApplyUrl({
                appId: this.gateway.getAppId(),
                scopes: [SENSITIVE_GROUP_MSG_SCOPE],
                brand: this.gateway.getDomain() as any,
                tokenType: 'tenant',
              });
              const eventSubUrl = buildEventSubUrl({
                appId: this.gateway.getAppId(),
                brand: this.gateway.getDomain() as any,
              });
              const permissionPageUrl = buildPermissionPageUrl({
                appId: this.gateway.getAppId(),
                brand: this.gateway.getDomain() as any,
              });

              const warningMsg = `💬 **【重要体验提示 — 免 @ 权限】**\n\n` +
                `您刚才成功创建了项目群「${params.group_name}」。\n\n` +
                `⚠️ **检测到您的 Bot 尚未开通「读取关联群聊内所有消息」敏感权限（\`${SENSITIVE_GROUP_MSG_SCOPE}\`）。**\n` +
                `由于飞书平台限制，如果您不开通此权限，您在此群里提问时**每次消息都必须强制 @ 机器人**，体验较为繁琐。\n\n` +
                `💡 **建议您一键申请开通此免 @ 权限（无需中断当前体验）：**\n` +
                `  1️⃣ **第一步：一键申请权限（自动预选）**\n` +
                `     👉 ${applyUrl}\n` +
                `  2️⃣ **第二步：在事件订阅页确认订阅 \`im.message.receive_v1\`**\n` +
                `     👉 ${eventSubUrl}\n` +
                `  3️⃣ **第三步：在权限管理页申请发布一个版本**\n` +
                `     👉 ${permissionPageUrl}\n\n` +
                `开通后即可在群内直接对话，实现无缝协作！`;

              await this.gateway.sendMessage(privateChatId, warningMsg);
            }
          } catch (err: any) {
            dwarn(`[CreateProjectGroupTool] Check scopes or send warning failed: ${err.message}`);
          }
        })();
      }

      return {
        llmContent: `Successfully created project directory at '${absPath}', and created dedicated Feishu group chat '${params.group_name}' with ID '${newChatId}'. Invited user and sent setup ready notification into the group successfully.`,
        returnDisplay: `Successfully created project and group chat ${params.group_name}`
      };
    } catch (e: any) {
      return {
        llmContent: `Error during project creation and binding: ${e.message}`,
        returnDisplay: `Error: ${e.message}`
      };
    }
  }
}

/** 通用 MessageActionReturn 包装 */
function msg(content: string): SlashCommandActionReturn {
  return { type: 'message', messageType: 'info', content };
}

export const feishuCommand: SlashCommand = {
  name: 'feishu',
  altNames: ['飞书'],
  description: t('feishu.command.description'),
  kind: CommandKind.BUILT_IN,

  // /feishu（无子命令）→ 显示帮助
  action: async () => msg(await handleInteractive()),

  subCommands: [
    {
      name: 'setup',
      description: t('feishu.subcmd.setup.description'),
      kind: CommandKind.BUILT_IN,
      action: async (ctx, args) => msg(await handleSetup(args, ctx)),
    },
    {
      name: 'start',
      description: t('feishu.subcmd.start.description'),
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => msg(await handleStart(ctx)),
    },
    {
      name: 'stop',
      description: t('feishu.subcmd.stop.description'),
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => {
        return msg(await handleStop(ctx));
      },
    },
    {
      name: 'status',
      description: t('feishu.subcmd.status.description'),
      kind: CommandKind.BUILT_IN,
      action: async () => msg(await handleStatus()),
    },
    {
      name: 'logout',
      description: t('feishu.subcmd.logout.description'),
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => msg(await handleLogout(ctx)),
    },
    {
      name: 'allow',
      description: t('feishu.subcmd.allow.description'),
      kind: CommandKind.BUILT_IN,
      action: async (_ctx, args) => msg(await handleAllow(args)),
    },
    {
      name: 'deny',
      description: t('feishu.subcmd.deny.description'),
      kind: CommandKind.BUILT_IN,
      action: async (_ctx, args) => msg(await handleDeny(args)),
    },
    {
      name: 'allowlist',
      description: t('feishu.subcmd.allowlist.description'),
      kind: CommandKind.BUILT_IN,
      action: async () => msg(await handleAllowlist()),
    },
    {
      name: 'help',
      description: t('feishu.subcmd.help.description'),
      kind: CommandKind.BUILT_IN,
      action: async () => msg(helpText()),
    },
  ],
};
