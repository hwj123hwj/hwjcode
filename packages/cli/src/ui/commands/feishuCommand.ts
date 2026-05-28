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
import { FeishuGateway, FeishuMessage, FeishuFooterMetrics, buildCardKitFinalCard } from '../../services/feishu/gateway.js';
import { SendFeishuFileTool } from '../../services/feishu/feishu-send-file-tool.js';
import {
  REQUIRED_APP_SCOPES,
  SENSITIVE_GROUP_MSG_SCOPE,
  buildScopeApplyUrl,
  buildEventSubUrl,
  buildPermissionPageUrl,
  missingScopes as computeMissingScopes,
} from '../../services/feishu/scopes.js';
import { getEncoding } from 'js-tiktoken';
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
  loadServerHierarchicalMemory,
  FileDiscoveryService,
  ProxyAuthManager,
  SettingsManager,
  MarketplaceManager,
  SkillLoader,
  getSpecificMimeType,
} from 'deepv-code-core';
import { CommandService } from '../../services/CommandService.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { InlineCommandLoader } from '../../services/InlineCommandLoader.js';
import { ExtensionCommandLoader } from '../../services/ExtensionCommandLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { PluginCommandLoader } from '../../services/skill/loaders/plugin-command-loader.js';
import { SettingScope } from '../../config/settings.js';
import { getAvailableModels } from './modelCommand.js';
import { getCreditsService } from '../../services/creditsService.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { dlog, dwarn, derror } from '../../services/feishu/logger.js';
import { t, tp } from '../utils/i18n.js';
import { Part, PartListUnion, Type } from '@google/genai';

/** 当前全局网关实例（进程内单例） */
let activeGateway: FeishuGateway | null = null;

/** 正在处理的飞书消息计数器 */
let activeProcessingCount = 0;

function incrementProcessingCount() {
  activeProcessingCount++;
  if (activeProcessingCount === 1) {
    appEvents.emit(AppEvent.FeishuBotProcessingStart);
  }
}

function decrementProcessingCount() {
  activeProcessingCount = Math.max(0, activeProcessingCount - 1);
  if (activeProcessingCount === 0) {
    appEvents.emit(AppEvent.FeishuBotProcessingEnd);
  }
}

function resetProcessingCount() {
  if (activeProcessingCount > 0) {
    activeProcessingCount = 0;
    appEvents.emit(AppEvent.FeishuBotProcessingEnd);
  }
}

/**
 * ask_user_question 在飞书侧等待用户作答的超时时间（毫秒）。
 *
 * CLI 原生的 ask_user_question 工具无任何超时——终端对话框会无限期等待用户。
 * 飞书侧无法真正无限等待（常驻 Promise 会占内存、AI 任务会僵死），因此给一个
 * 很长但有限的超时：30 分钟，给足用户看消息和思考的时间，同时避免永久挂起。
 */
const FEISHU_ASK_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

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

/** 各会话最后一笔成功交易的 Token 使用量 */
const chatLastTokenUsage = new Map<string, any>();

/** 全局命令上下文引用 */
let globalCommandContext: CommandContext | null = null;

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface FeishuProjectRoute {
  projectRoot?: string;
  description?: string;
  model?: string;
  thinking?: {
    mode: 'on' | 'off' | 'auto';
    effort?: 'auto' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  };
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
 * 飞书独立会话加载并过滤项目上下文/记忆 (DEEPV.md, AGENTS.md 等)
 */
async function loadFeishuSessionMemory(workspaceRoot: string, settings?: any): Promise<{ userMemory: string; memoryTokenCount: number; geminiMdFileCount: number }> {
  try {
    const fileService = new FileDiscoveryService(workspaceRoot);
    const debugMode = false;

    const fileFiltering = {
      respectGitIgnore: settings?.merged?.fileFiltering?.respectGitIgnore ?? true,
      respectGeminiIgnore: settings?.merged?.fileFiltering?.respectGeminiIgnore ?? true,
      enableRecursiveFileSearch: settings?.merged?.fileFiltering?.enableRecursiveFileSearch ?? true,
    };

    const result = await loadServerHierarchicalMemory(
      workspaceRoot,
      debugMode,
      fileService,
      [], // extensionContextFilePaths
      fileFiltering,
      settings?.merged?.memoryDiscoveryMaxDirs,
    );

    // Apply projectMemoryMode filtering (all / deepv-only / none)
    const mode = settings?.merged?.projectMemoryMode || 'all';
    let filtered = result;

    if (mode === 'none') {
      filtered = { memoryContent: '', fileCount: 0, filePaths: [] };
    } else if (mode === 'deepv-only') {
      const filteredPaths = result.filePaths.filter((fp: string) => {
        const filename = fp.split(/[\\/]/).pop() || '';
        return !filename.toUpperCase().startsWith('AGENTS');
      });
      if (filteredPaths.length !== result.filePaths.length) {
        const filteredContent = result.memoryContent
          .split('\n\n')
          .filter((block: string) => !block.includes('AGENTS.md ---'))
          .join('\n\n')
          .trim();
        filtered = {
          memoryContent: filteredContent,
          fileCount: filteredPaths.length,
          filePaths: filteredPaths,
        };
      }
    }

    // 计算 memory token
    let memoryTokenCount = 0;
    try {
      const enc = getEncoding('cl100k_base');
      memoryTokenCount = enc.encode(filtered.memoryContent).length;
    } catch (e) {
      // ignore token count error
    }

    return {
      userMemory: filtered.memoryContent,
      memoryTokenCount,
      geminiMdFileCount: filtered.fileCount,
    };
  } catch (err: any) {
    dwarn(`Failed to load memory for isolated session on ${workspaceRoot}: ${err.message}`);
    return {
      userMemory: '',
      memoryTokenCount: 0,
      geminiMdFileCount: 0,
    };
  }
}

/**
 * 写入路由表（增量更新）
 */
async function saveProjectRoute(chatId: string, routeUpdate: Partial<FeishuProjectRoute>): Promise<void> {
  try {
    const routes = await loadProjectRoutes();
    const existing = routes[chatId] || {};
    routes[chatId] = {
      ...existing,
      ...routeUpdate,
    };
    fs.writeFileSync(ROUTE_CONFIG_FILE, JSON.stringify(routes, null, 2), 'utf8');
    dlog(`[Router] Successfully updated Chat ID '${chatId}' info in feishu-projects.json`);
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
 * 飞书模式下拦截 ask_user_question：发送交互「表单卡片」，等用户提交
 *
 * 主路径：用 gateway.askQuestionsViaForm() 发一张 schema 2.0 表单卡片，
 *   每个问题 = 下拉单选（含「其他」）+ 自定义填空框，底部统一提交按钮。
 *   用户点提交后通过长连接 card.action.trigger 一次性带回所有答案。
 *
 * 兜底：当表单卡片发送失败时，回退到逐题文本序号选择模式（waitForCardAction
 *   内部也会在普通卡片失败时再退到纯文本）。
 *
 * 超时（30 分钟）→ 对应问题答案为空，提示"用户未回答"。
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
  // 🚀 数据容错与自愈：处理 questions 数组中可能出现的字符串或非标准对象
  const normalizedQuestions = (args.questions || []).map((item: any) => {
    if (!item) return { question: 'Question', options: [] };
    if (typeof item === 'string') {
      return {
        question: item,
        header: 'Question',
        options: [],
      };
    }
    const question = String(item.question || '').trim() || 'Question';
    let header = String(item.header || 'Question').trim();
    if (header.length > 12) {
      header = header.substring(0, 12);
    }
    let options = item.options || [];
    if (Array.isArray(options)) {
      options = options.map((opt: any) => {
        if (typeof opt === 'string') {
          return { label: opt, description: '' };
        }
        if (opt && typeof opt === 'object') {
          const rawLabel = opt.label || opt.value || 'Option';
          return {
            ...opt,
            label: String(rawLabel).trim() || 'Option',
            description: opt.description ? String(opt.description).trim() : '',
          };
        }
        return { label: 'Option', description: '' };
      });
    } else {
      options = [];
    }
    return {
      ...item,
      question,
      header,
      options,
    };
  });

  const answers: Record<string, string> = {};

  // 过滤出有选项的问题（无选项的无法用卡片收集）
  const answerableQuestions = normalizedQuestions.filter(
    (q) => (q.options || []).length > 0,
  );
  for (const q of normalizedQuestions) {
    if ((q.options || []).length === 0) {
      answers[q.question] = '(无选项)';
    }
  }

  // 🎯 主路径：一张表单卡片一次性收集全部答案
  let formSucceeded = false;
  if (answerableQuestions.length > 0) {
    const result = await gateway.askQuestionsViaForm(
      chatId,
      answerableQuestions.map((q) => ({
        question: q.question,
        header: q.header,
        options: q.options || [],
        multiSelect: q.multiSelect,
      })),
      FEISHU_ASK_QUESTION_TIMEOUT_MS,
      replyToMessageId,
    );

    if (result.ok && result.answers) {
      formSucceeded = true;
      const summaryLines: string[] = [];
      for (const q of answerableQuestions) {
        const ans = result.answers[q.question] || '';
        if (ans) {
          answers[q.question] = ans;
          summaryLines.push(`✅ ${q.header || q.question}: ${ans}`);
        } else {
          answers[q.question] = '用户未回答，请自行决策';
          summaryLines.push(`⏭ ${q.header || q.question}: 未回答`);
        }
      }
      // 回执：告诉用户已收到答案
      await gateway.sendMessage(
        chatId,
        `📋 已收到你的回答：\n${summaryLines.join('\n')}`,
      );
    }
  }

  // 🛟 兜底：表单卡片失败 → 逐题文本/按钮选择
  if (!formSucceeded) {
    for (const q of answerableQuestions) {
      const options = q.options || [];

      // 构建卡片正文：列出选项及其描述
      const contentLines = options.map((opt) => {
        const line = `**${opt.label}**`;
        return opt.description ? `${line}: ${opt.description}` : line;
      });
      const content = contentLines.join('\n\n');

      // 构建按钮
      const buttons = options.map((opt) => ({
        label: opt.label,
        value: opt.label,
      }));
      buttons.push({ label: '⏭ 跳过', value: '__skip__' });

      const title = q.header ? `${q.header}: ${q.question}` : q.question;

      const userChoice = await gateway.waitForCardAction(
        chatId,
        title,
        content,
        buttons,
        '__timeout__',
        FEISHU_ASK_QUESTION_TIMEOUT_MS,
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
        answers[q.question] = '用户未在规定时间内回答，请自行决策';
      } else if (userChoice === '__skip__') {
        answers[q.question] = '用户选择跳过，请自行决策';
      } else {
        answers[q.question] = userChoice;
      }
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
 * 格式化精美的飞书端纯英文 /status 状态卡片内容
 */
async function formatStatusMessage(config: any, geminiClient: any, chatId?: string): Promise<string> {
  const cliVersion = await getVersion().catch(() => 'unknown');
  const currentModel = config?.getModel() || '未选择';
  const cloudModelInfo = config?.getCloudModelInfo?.(currentModel);
  const modelName = cloudModelInfo?.displayName || currentModel;

  const currentConfig = config?.getThinkingConfig() || { mode: 'auto', effort: 'auto' };

  const proxyAuthManager = ProxyAuthManager.getInstance();
  const userInfo = proxyAuthManager.getUserInfo();
  const userName = userInfo?.name || 'Not Available';

  const lastTokenUsage = chatId ? chatLastTokenUsage.get(chatId) : null;
  const input = lastTokenUsage?.inputTokens || uiTelemetryService.getLastPromptTokenCount() || 0;
  const output = lastTokenUsage?.outputTokens || 0;
  const cacheRead = lastTokenUsage?.cacheReadInputTokens || 0;
  const total = input + output;
  const cacheHitRate = input > 0 ? ((cacheRead / input) * 100).toFixed(1) + '%' : '0.0%';

  let remainingCredits = 'Not Available';
  try {
    const creditsInfo = await getCreditsService().getCreditsInfo(true);
    if (creditsInfo) {
      remainingCredits = creditsInfo.remainingCredits.toLocaleString();
    }
  } catch {
    // ignore
  }

  const maxTokens = tokenLimit(currentModel, config || undefined);
  const contextK = input > 0 ? (input / 1000).toFixed(1) + 'k' : '0k';
  const maxM = maxTokens > 0 ? (maxTokens / 1000000).toFixed(1) + 'm' : 'Unknown';
  const contextPct = maxTokens > 0 ? ((input / maxTokens) * 100).toFixed(0) + '%' : '0%';

  return [
    `Ⓥ **DeepV Code** v${cliVersion}`,
    `🧠 **Model**: ${modelName}`,
    `⚙️ **Auth**: ${userName}`,
    `🧮 **Token Usage**`,
    `  Input: ${input.toLocaleString()}`,
    `  Cache Read: ${cacheRead.toLocaleString()}`,
    `  Output: ${output.toLocaleString()}`,
    `  Total: ${total.toLocaleString()}`,
    `  Cache Hit Rate: ${cacheHitRate}`,
    `  Credits: ${lastTokenUsage?.creditsUsage != null ? lastTokenUsage.creditsUsage : 0} / ${remainingCredits}`,
    `📚 **Context**: ${contextK}/${maxM} (${contextPct})`,
    `🧵 **Session**: feishu_${chatId || 'unknown'}`,
    `⚙️ **Think**: ${currentConfig.mode === 'off' ? 'off' : (currentConfig.effort || 'auto')}`,
  ].join('\n');
}

/**
 * 从当前状态生成 FeishuFooterMetrics。
 * @param config 配置对象
 * @param geminiClient Gemini 客户端
 * @param lastRequestTokenUsage 最近一笔请求的真实 token 使用状况
 * @returns FeishuFooterMetrics 对象
 */
async function getFeishuStatusMetrics(
  config: any,
  geminiClient: any,
  lastRequestTokenUsage?: any,
): Promise<FeishuFooterMetrics> {
  const metrics: FeishuFooterMetrics = {};

  try {
    const currentModel = config?.getModel() || '未选择';
    const cloudModelInfo = config?.getCloudModelInfo?.(currentModel);
    metrics.model = cloudModelInfo?.displayName || currentModel;

    const currentConfig = config?.getThinkingConfig() || { mode: 'auto', effort: 'auto' };
    if (currentConfig.mode !== 'off') {
      metrics.status = `思考级别: ${currentConfig.effort || 'auto'}`;
    }

    const maxTokens = tokenLimit(currentModel, config || undefined);

    if (lastRequestTokenUsage) {
      const input = lastRequestTokenUsage.inputTokens || 0;
      const output = lastRequestTokenUsage.outputTokens || 0;
      metrics.tokens = { input, output };

      if (lastRequestTokenUsage.cacheReadInputTokens > 0) {
        metrics.cacheRead = lastRequestTokenUsage.cacheReadInputTokens;
        metrics.cacheHitRate = input > 0 ? (lastRequestTokenUsage.cacheReadInputTokens / input) * 100 : 0;
      }
      if (lastRequestTokenUsage.creditsUsage > 0) {
        metrics.credits = lastRequestTokenUsage.creditsUsage;
      }
      if (input > 0 && maxTokens && maxTokens > 0) {
        metrics.contextPercentage = (input / maxTokens) * 100;
      }
    } else {
      const actualPromptTokens = uiTelemetryService.getLastPromptTokenCount();
      metrics.tokens = {
        input: actualPromptTokens || 0,
        output: 0, // Output tokens are not directly available here without full stream completion
      };

      // Calculate context percentage if possible (assuming actualPromptTokens is current context size)
      if (actualPromptTokens && maxTokens && maxTokens > 0) {
        metrics.contextPercentage = (actualPromptTokens / maxTokens) * 100;
      }
    }

  } catch (err: any) {
    dwarn(`Failed to get Feishu status metrics: ${err.message}`);
  }

  return metrics;
}

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
        const statusMsg = await formatStatusMessage(config, geminiClient, chatId);
        return statusMsg;
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
        if (chatId) {
          await saveProjectRoute(chatId, { thinking: updated });
        }
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
        if (chatId) {
          await saveProjectRoute(chatId, { thinking: updated });
        }
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

        if (chatId) {
          await saveProjectRoute(chatId, { model: actualModelName });
        }

        if (config) {
          config.setModel?.(actualModelName);
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

interface CliSlashCommandResult {
  type: 'text' | 'submit_prompt';
  content: string;
}

/**
 * 载入并执行通用的 CLI 斜杠命令
 */
async function handleCliSlashCommandInFeishu(
  messageText: string,
  config: any,
  chatId: string,
): Promise<CliSlashCommandResult | null> {
  const settingsManager = new SettingsManager();
  const marketplaceManager = new MarketplaceManager(settingsManager);
  const skillLoader = new SkillLoader(settingsManager, marketplaceManager);

  // 1. 初始化 loaders
  const loaders = [
    new McpPromptLoader(config),
    new BuiltinCommandLoader(config),
    new InlineCommandLoader(config),
    new ExtensionCommandLoader(config),
    new FileCommandLoader(config),
    new PluginCommandLoader(skillLoader, settingsManager),
  ];

  // 2. 加载所有的 CLI SlashCommand
  const abortController = new AbortController();
  const commandService = await CommandService.create(loaders, abortController.signal);
  const commands = commandService.getCommands();

  // 3. 解析用户输入的命令
  const trimmed = messageText.trim();
  const parts = trimmed.substring(1).trim().split(/\s+/);
  const commandPath = parts.filter((p) => p);

  if (commandPath.length === 0) {
    return null;
  }

  // 4. 寻找匹配的命令
  let currentCommands: readonly SlashCommand[] = commands;
  let commandToExecute: SlashCommand | undefined;
  let pathIndex = 0;

  for (const part of commandPath) {
    let foundCommand = currentCommands.find((cmd) => cmd.name === part);
    if (!foundCommand) {
      foundCommand = currentCommands.find((cmd) =>
        cmd.altNames?.includes(part),
      );
    }

    if (foundCommand) {
      commandToExecute = foundCommand;
      pathIndex++;
      if (foundCommand.subCommands) {
        currentCommands = foundCommand.subCommands;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  if (!commandToExecute) {
    return null; // 不是有效 CLI 斜杠命令
  }

  // 5. 提取参数
  const args = parts.slice(pathIndex).join(' ');

  // 6. 构造 CommandContext 并执行
  const collectedTexts: string[] = [];
  const context: CommandContext = {
    invocation: {
      raw: trimmed,
      name: commandToExecute.name,
      args,
    },
    isNonInteractive: true,
    services: {
      config,
      settings: globalCommandContext?.services?.settings || ({} as any),
      git: globalCommandContext?.services?.git,
      logger: console as any,
    },
    ui: {
      addItem: (item) => {
        if (item && item.text) {
          collectedTexts.push(item.text);
        }
        return Date.now();
      },
      clear: () => {
        collectedTexts.push('🧹 (屏幕已清空)');
      },
      setDebugMessage: () => {},
      pendingItem: null,
      setPendingItem: () => {},
      loadHistory: () => {},
      toggleCorgiMode: () => {},
      toggleVimEnabled: async () => false,
    },
    session: {
      stats: {
        sessionStartTime: new Date(),
        lastPromptTokenCount: 0,
        promptCount: 0,
        subAgentStats: {
          totalApiCalls: 0,
          totalErrors: 0,
          totalLatencyMs: 0,
          totalTokens: 0,
          promptTokens: 0,
          candidatesTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          thoughtsTokens: 0,
          toolTokens: 0,
        },
        metrics: {
          models: {},
          tools: {
            totalCalls: 0,
            totalSuccess: 0,
            totalFail: 0,
            totalDurationMs: 0,
            totalDecisions: {
              accept: 0,
              reject: 0,
              modify: 0,
            },
            byName: {},
          },
        },
      },
      cumulativeCredits: 0,
      totalSessionCredits: 0,
    },
  };

  if (commandToExecute.action) {
    const actionResult = await commandToExecute.action(context, args);

    // 如果命令执行返回了结果
    if (actionResult) {
      if (actionResult.type === 'message') {
        collectedTexts.push(actionResult.content);
      } else if (actionResult.type === 'submit_prompt') {
        return {
          type: 'submit_prompt',
          content: actionResult.content,
        };
      } else if (actionResult.type === 'dialog') {
        // 提供极致贴心的飞书端 TUI 交互拦截友好提示
        const dialogType = actionResult.dialog;
        let hint = `⚠️ **该命令需要终端（TUI）交互界面支持。**\n\n您当前正在通过【飞书机器人远程模式】进行操作，无法打开本地 TUI 设置浮窗。`;

        if (dialogType === 'settings-menu' || dialogType === 'theme' || dialogType === 'editor') {
          hint += `\n\n💡 **您可以通过输入具体的配置子命令来直接配置（免交互）**:\n` +
                  `  • \`/model <模型名>\` - 在线直接切换 AI 模型\n` +
                  `  • \`/thinking <off|auto|high>\` - 配置 AI 思考模式与力度`;
        } else if (dialogType === 'debate-wizard') {
          hint += `\n\n💡 **您可以通过以下免交互的辩论子命令来进行管理**:\n` +
                  `  • \`/debate status\` - 查看当前辩论详情\n` +
                  `  • \`/debate continue\` - 继续暂停的辩论\n` +
                  `  • \`/debate end\` - 强制结束当前辩论`;
        } else if (dialogType === 'goal-wizard') {
          hint += `\n\n💡 **目标驱动模式在飞书端暂仅支持清空操作**:\n` +
                  `  • \`/goal clear\` - 结束当前 goal 模式，释放契约约束\n\n` +
                  `*(如需开启新目标契约任务，请直接在您的 CLI 终端物理机上通过 \`/goal\` 设定)*`;
        }

        collectedTexts.push(hint);
      } else if (actionResult.type === 'select_session') {
        collectedTexts.push(
          `⚠️ **该命令需要 TUI 列表光标交互支持。**\n\n` +
          `您当前处于飞书端，无法进行光标选择。建议您通过 \`/new\` 直接开始一个干净的新会话。`
        );
      } else if (actionResult.type === 'quit') {
        collectedTexts.push(
          `⚠️ **无法在远程模式下终止服务端进程。**\n\n` +
          `如果您想中断当前的 AI 生成任务，请使用 \`/stop\` 命令。`
        );
      }
    }
  }

  // 返回收集到的所有输出文本
  return {
    type: 'text',
    content: collectedTexts.join('\n'),
  };
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

      const settings = globalCommandContext?.services?.settings;

      // 🚀 加载独立会话的项目级/全局指令记忆 (DEEPV.md / AGENTS.md)，确保 AI 在独立会话中继承完整的行为规范约束
      const sessionMemory = await loadFeishuSessionMemory(workspaceRoot, settings);

      dlog(`[Router] Instantiating isolated environment for chatId '${msg.chatId}' on root '${workspaceRoot}' with ${sessionMemory.geminiMdFileCount} memory file(s)`);
      const isolatedConfig = new Config({
        sessionId: `feishu-${msg.chatId}-${Date.now()}`,
        cwd: workspaceRoot,
        debugMode: config?.getDebugMode() || false,
        targetDir: workspaceRoot,
        model: route?.model || settings?.merged?.preferredModel || 'auto',
        userMemory: sessionMemory.userMemory,
        memoryTokenCount: sessionMemory.memoryTokenCount,
        geminiMdFileCount: sessionMemory.geminiMdFileCount,
        customModels: activeConfig?.getCustomModels() || [],
        cloudModels: activeConfig?.getCloudModels() || [],
        proxy: activeConfig?.getProxy(),
        customProxyServerUrl: activeConfig?.getCustomProxyServerUrl(),
        mcpServers: activeConfig?.getMcpServers(),
      });

      try {
        // 🚀 关键：必须先对全新的 Config 实例执行 initialize()，否则内部的 toolRegistry、
        // hookSystem 等核心组件不会被构建，导致 refreshAuth 抛错或 fallback 回主环境，
        // 从而引发“群聊工作目录依旧是 D:\projects\deepVcode\DeepCode”的安全状态漂移 Bug。
        dlog(`[Router] Initializing isolatedConfig on '${workspaceRoot}'...`);
        await isolatedConfig.initialize();

        // 🚀 回放持久化的思考模式与力度
        if (route?.thinking) {
          dlog(`[Router] Replaying thinking config for chatId '${msg.chatId}': ${JSON.stringify(route.thinking)}`);
          isolatedConfig.setThinkingConfig(route.thinking);
        }

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

    // 🚀 斜杠命令（/help, /new, /stop, /bind 等）高优先级快速通道拦截：
    // 这些命令完全由系统控制或脚本程序处理，不进入 LLM 上下文，也不存在长耗时。
    // 为了极致的用户体验，它们应该完全绕过异步消息队列，直接高优先级秒速执行响应，绝不参与排队！
    if (messageText.startsWith('/')) {
      dlog(`[Router] High-priority slash command matched: ${messageText}`);
      try {
        // 1. 尝试匹配飞书特定的专用命令
        const cmdResult = await handleFeishuCommand(messageText, currentClient, currentConfig, msg.chatId);
        if (cmdResult !== null) {
          tuiContext?.addItem({ type: 'info', text: cmdResult }, Date.now());

          // 🚀 斜杠命令统一使用 CardKit 2.0 终态卡片规格发送，保证视觉完美统一
          const metrics = await getFeishuStatusMetrics(currentConfig, currentClient, chatLastTokenUsage.get(msg.chatId));
          const card = buildCardKitFinalCard(cmdResult, metrics, 'DeepV Code');
          const cardId = await gateway.createCardKitCard(card);
          if (cardId) {
            await gateway.sendCardKitMessage(msg.chatId, cardId, msg.messageId);
          } else {
            await gateway.sendMessage(msg.chatId, cmdResult, msg.messageId);
          }
          return null; // 🚀 返回 null，防止 gateway.ts 底层二次发送纯文本消息造成重复
        }

        // 2. 如果飞书专有命令未匹配，尝试加载并执行通用的 CLI 斜杠命令
        const cliCmdResult = await handleCliSlashCommandInFeishu(messageText, currentConfig, msg.chatId);
        if (cliCmdResult !== null) {
          if (cliCmdResult.type === 'submit_prompt') {
            // 命令指示重新投喂 prompt 给 LLM agent (例如 /ask 的行为)
            const fakeMsg: FeishuMessage = {
              ...msg,
              text: cliCmdResult.content,
            };
            dlog(`[Router] CLI Slash command redirected to prompt queue: ${cliCmdResult.content}`);

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
              queue!.push({ msg: fakeMsg, resolve, reject });
              const richErr = initErrorMsg || (debugTrail.length ? `trail=[${debugTrail.join('|')}]` : '');
              processMessageQueueForChat(gateway, currentConfig, currentClient, creds, msg.chatId, richErr);
            });
          }

          // 常规文本结果输出
          const responseText = cliCmdResult.content || `✅ 命令已成功执行。`;
          tuiContext?.addItem({ type: 'info', text: responseText }, Date.now());

          const metrics = await getFeishuStatusMetrics(currentConfig, currentClient, chatLastTokenUsage.get(msg.chatId));
          const card = buildCardKitFinalCard(responseText, metrics, 'DeepV Code');
          const cardId = await gateway.createCardKitCard(card);
          if (cardId) {
            await gateway.sendCardKitMessage(msg.chatId, cardId, msg.messageId);
          } else {
            await gateway.sendMessage(msg.chatId, responseText, msg.messageId);
          }
          return null; // 🚀 防止 gateway.ts 底层二次发送纯文本消息造成重复
        }

        // 3. 兜底：既不是飞书专用命令，也不是 CLI 的命令，才判为未知斜杠命令
        const hint = `❓ 未知命令: ${messageText.split(/\s+/)[0]}\n\n输入 /help 查看可用命令`;
        tuiContext?.addItem({ type: 'info', text: hint }, Date.now());

        const metrics = await getFeishuStatusMetrics(currentConfig, currentClient, chatLastTokenUsage.get(msg.chatId));
        const card = buildCardKitFinalCard(hint, metrics, 'DeepV Code');
        const cardId = await gateway.createCardKitCard(card);
        if (cardId) {
          await gateway.sendCardKitMessage(msg.chatId, cardId, msg.messageId);
        } else {
          await gateway.sendMessage(msg.chatId, hint, msg.messageId);
        }
        return null; // 🚀 返回 null，防止 gateway.ts 底层二次发送纯文本消息造成重复
      } catch (err: any) {
        const errMsg = `❌ 执行命令出错：${err.message || err}`;
        tuiContext?.addItem({ type: 'info', text: errMsg }, Date.now());

        const metrics = await getFeishuStatusMetrics(currentConfig, currentClient, chatLastTokenUsage.get(msg.chatId));
        const card = buildCardKitFinalCard(errMsg, metrics, 'DeepV Code (Error)');
        const cardId = await gateway.createCardKitCard(card);
        if (cardId) {
          await gateway.sendCardKitMessage(msg.chatId, cardId, msg.messageId);
        } else {
          await gateway.sendMessage(msg.chatId, errMsg, msg.messageId);
        }
        return null; // 🚀 返回 null，防止 gateway.ts 底层二次发送纯文本消息造成重复
      }
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

  interface MarkdownBlock {
    type: 'text' | 'tool';
    content: string;
  }

  function renderBlocks(blocks: MarkdownBlock[]): string {
    const toolBlocks = blocks.filter(b => b.type === 'tool');
    const totalTools = toolBlocks.length;

    if (totalTools <= 5) {
      return blocks.map(b => b.content).join('\n\n').trim();
    }

    const collapsedCount = totalTools - 5;
    const renderedParts: string[] = [];
    let toolSeenCount = 0;
    let collapsedHeaderAdded = false;

    for (const block of blocks) {
      if (block.type === 'tool') {
        toolSeenCount++;
        if (toolSeenCount <= collapsedCount) {
          if (!collapsedHeaderAdded) {
            renderedParts.push(`*（已折叠 ${collapsedCount} 个历史工具调用）*`);
            collapsedHeaderAdded = true;
          }
          continue;
        }
      }
      renderedParts.push(block.content);
    }

    return renderedParts.join('\n\n').trim();
  }

  function renderCurrentDisplay(
    blocks: MarkdownBlock[],
    activeResponseText: string = '',
    inProgressToolMarkdown: string = '',
  ): string {
    const renderedPast = renderBlocks(blocks);
    let display = renderedPast;

    if (activeResponseText) {
      const separator = display ? (display.endsWith('\n\n') ? '' : (display.endsWith('\n') ? '\n' : '\n\n')) : '';
      display = display + separator + activeResponseText;
    }

    if (inProgressToolMarkdown) {
      const separator = display ? (display.endsWith('\n\n') ? '' : (display.endsWith('\n') ? '\n' : '\n\n')) : '';
      display = display + separator + inProgressToolMarkdown;
    }

    return display;
  }

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

    // 🎯 DEBUG: Log the raw messageText to understand image attachment format
    dlog(`[Feishu Debug] Raw messageText from Feishu: "${messageText}"`);

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
    const blocks: MarkdownBlock[] = [];
    let lastRequestTokenUsage: any = null;
    // CardKit 2.0 流式句柄。为 null 表示流式失败/未启用，会回退到 sendCard 静态卡。
    let streaming: {
      pushContent: (content: string) => Promise<boolean>;
      pushFooter: (metrics: FeishuFooterMetrics) => Promise<boolean>;
      finalize: (finalContent: string, finalFooterMetrics?: FeishuFooterMetrics) => Promise<boolean>;
    } | null = null;

    try {
      incrementProcessingCount();
      // 确保 chat 已初始化
      await geminiClient.waitForChatInitialized();

      // 🎯 下载飞书消息中的图片到项目 .deepvcode/clipboard/ 目录
      // 图片路径以纯文本绝对路径形式拼接到消息中，由 read_many_files 工具自动接管读取
      let messageTextForAI = messageText;
      let currentMessage: PartListUnion = messageTextForAI;

      if (msg.pendingImages && msg.pendingImages.length > 0) {
        const projectRoot = config?.getProjectRoot?.() || process.cwd();
        const fs = await import('node:fs');
        const pathModule = await import('node:path');
        const clipboardDir = pathModule.join(projectRoot, '.deepvcode', 'clipboard');
        fs.mkdirSync(clipboardDir, { recursive: true });

        const imagePaths: string[] = [];
        for (const img of msg.pendingImages) {
          const localPath = await gateway.downloadImageToDir(msg.messageId, img.imageKey, clipboardDir);
          if (localPath) {
            imagePaths.push(localPath);
            dlog(`[Feishu] Image downloaded to clipboard: ${localPath}`);
          } else {
            dwarn(`[Feishu] Failed to download image key: ${img.imageKey}`);
            imagePaths.push(`[图片下载失败: ${img.imageKey}]`);
          }
        }

        // 重建消息文本：把占位符替换为实际绝对路径
        let reconstructedText = msg.text;
        for (let i = 0; i < msg.pendingImages.length; i++) {
          reconstructedText = reconstructedText.replace(msg.pendingImages[i].placeholder, imagePaths[i]);
        }
        msg.text = reconstructedText;
        messageTextForAI = reconstructedText.trim();
        dlog(`[Feishu] Reconstructed message with image paths: "${messageTextForAI}"`);

        // 🎯 完美多模态对齐：既保留文本绝对路径，又在消息中附加实际图片的 base64 作为 inlineData Part
        // 这可以让支持多模态的模型直接读取图片提高效率，同时让非多模态模型依然能利用路径通过工具访问图片，实现自适应！
        const messageParts: Part[] = [{ text: messageTextForAI }];
        for (const localPath of imagePaths) {
          if (localPath && !localPath.startsWith('[图片下载失败') && fs.existsSync(localPath)) {
            try {
              // 🎯 统一走 getSpecificMimeType（基于扩展名的 mime 表），
              // 配合落盘时的真实类型探测，保证 inlineData.mimeType 与图片字节一致。
              // 非图片或无法识别时兜底 image/jpeg，避免传出空 mimeType。
              const detected = getSpecificMimeType(localPath);
              const mimeType = detected && detected.startsWith('image/')
                ? detected
                : 'image/jpeg';
              const base64Data = fs.readFileSync(localPath).toString('base64');
              messageParts.push({
                inlineData: {
                  mimeType,
                  data: base64Data,
                }
              });
              dlog(`[Feishu] Multimodal image part successfully appended for AI from: ${localPath}`);
            } catch (e: any) {
              dwarn(`[Feishu] Failed to convert local image to inlineData for AI: ${e?.message || e}`);
            }
          }
        }

        if (messageParts.length > 1) {
          currentMessage = messageParts;
        } else {
          currentMessage = messageTextForAI;
        }
      } else {
        currentMessage = messageTextForAI;
      }

      const MAX_TURNS = 100;

      // Get initial footer metrics
      const initialFooterMetrics = await getFeishuStatusMetrics(config, geminiClient);

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
              const currentTotalMarkdown = renderCurrentDisplay(blocks, responseText);
              const trimmed = currentTotalMarkdown.trim();
              if (trimmed) {
                const now = Date.now();
                if (!activeCardId) {
                  // 第一次发送：用 CardKit 2.0 创建一张流式卡片
                  const handle = await gateway.sendStreamingCardWithFooter(
                    msg.chatId,
                    trimmed,
                    initialFooterMetrics,
                    msg.messageId,
                  );
                  if (handle.messageId) {
                    activeCardId = handle.messageId;
                    streaming = {
                      pushContent: handle.pushContent,
                      pushFooter: handle.pushFooter,
                      finalize: handle.finalize,
                    };
                  } else {
                    // CardKit 创建失败，回退到老路径：发普通卡片
                    activeCardId = await gateway.sendCard(
                      msg.chatId,
                      'DeepV Code AI 助理',
                      trimmed,
                      [],
                      initialFooterMetrics,
                      msg.messageId,
                    );
                  }
                  lastUpdateTime = now;
                } else {
                  // 🎯 飞书卡片长度容量防超限保护 & 优雅分割：
                  // 飞书单个卡片数据限制为 30KB 左右（大约相当于 8000-10000 字符）。
                  // 如果当前卡片渲染 of Markdown 超过安全阈值（8500 字符），
                  // 我们在最近一个段落/换行处进行劈裂，将前半部分作为本卡片终态，
                  // 后半部分（多余的）开启一个新卡片继续增量流式更新输出！
                  const MAX_CARD_CHAR_LIMIT = 8500;
                  if (trimmed.length > MAX_CARD_CHAR_LIMIT) {
                    // 在 responseText 中寻找最近的一个段落分割点 (如 \n\n 或 \n)
                    let splitIndex = responseText.lastIndexOf('\n\n');
                    if (splitIndex === -1 || splitIndex < responseText.length - 3000) {
                      splitIndex = responseText.lastIndexOf('\n');
                    }
                    // 兜底：如果实在找不到合适的位置，就从中间偏后位置截断
                    if (splitIndex === -1 || splitIndex < 1000 || splitIndex > responseText.length - 200) {
                      splitIndex = Math.max(1000, responseText.length - 1500);
                    }

                    const left = responseText.slice(0, splitIndex);
                    const right = responseText.slice(splitIndex);

                    const oldCardContent = renderCurrentDisplay(blocks, left);
                    dlog(`[Feishu] Card content size (${trimmed.length} chars) exceeds safety threshold (${MAX_CARD_CHAR_LIMIT}). Splitting card! Left length: ${left.length}, Right length: ${right.length}`);

                    // 1. 本卡片封卷：将其更新为"分段输出中"的终态卡片
                    if (streaming) {
                      const intermediateFooter = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                      intermediateFooter.status = '分段输出中';
                      await streaming.finalize(oldCardContent, intermediateFooter);
                      streaming = null;
                    } else {
                      const intermediateFooter = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                      intermediateFooter.status = '分段输出中';
                      await safeUpdateCardWithRetry(gateway, activeCardId, 'DeepV Code AI 助理', oldCardContent, intermediateFooter);
                    }

                    // 2. 状态重置：清空历史 blocks，将 responseText 设置为多出的 right，并将 activeCardId 置为 null，
                    // 下一次 event 循环会自动检测到 activeCardId === null 进而创建一个全新的流式卡片！
                    blocks.length = 0;
                    responseText = right;
                    activeCardId = null;
                  } else if (streaming && now - lastUpdateTime >= MIN_UPDATE_INTERVAL) {
                    // CardKit 流式：直接推增量正文，飞书自带打字机动画
                    await streaming.pushContent(trimmed);
                    lastUpdateTime = now;
                  } else if (!streaming && now - lastUpdateTime >= MIN_UPDATE_INTERVAL) {
                    // 老路径回退（CardKit 创建失败时）：im.message.patch 整卡更新
                    const metrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                    metrics.status = '思考中';
                    await gateway.updateCard(activeCardId, 'DeepV Code AI 助理', trimmed, metrics);
                    lastUpdateTime = now;
                  }
                }
              }
              break;
            }
            case GeminiEventType.ToolCallRequest:
              toolCallRequests.push(event.value);
              break;
            case GeminiEventType.TokenUsage:
              lastRequestTokenUsage = event.value;
              if (msg && msg.chatId) {
                chatLastTokenUsage.set(msg.chatId, event.value);
              }
              break;
            case GeminiEventType.ChatCompressed:
              tuiContext?.addItem({ type: 'info', text: t('feishu.tui.context_compressed') }, Date.now());
              break;
            case GeminiEventType.Error:
              throw new Error(event.value?.error?.message || 'unknown error');
          }
        }

        // 把当前这轮回复合并进 blocks 中
        if (responseText) {
          blocks.push({ type: 'text', content: responseText });
        }

        const currentFinalMarkdown = renderCurrentDisplay(blocks);

        // 结束流式输出，做最终的、无中间提示的更新
        if (activeCardId && streaming) {
          // CardKit 流式中：只 pushContent 把最终文本推上去，footer 保持流式状态
          await streaming.pushContent(currentFinalMarkdown || '（无回复）');
        } else if (activeCardId && !streaming) {
          // 老路径回退：整卡 patch
          const finalFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          finalFooterMetrics.status = '已完成';
          const success = await safeUpdateCardWithRetry(gateway, activeCardId, 'DeepV Code AI 助理', currentFinalMarkdown || '（无回复）', finalFooterMetrics);
          if (!success) {
            dwarn('[Feishu Stream] Failed to update final card with retry. Fallback to sending new card.');
            activeCardId = await gateway.sendCard(
              msg.chatId,
              'DeepV Code AI 助理',
              currentFinalMarkdown || '（无回复）',
              [],
              finalFooterMetrics,
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
            const finalFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
            finalFooterMetrics.status = '已完成';
            // 兜底分支文本量不大，直接发个静态卡即可（不必再走 CardKit）
            activeCardId = await gateway.sendCard(
              msg.chatId,
              'DeepV Code AI 助理',
              currentFinalMarkdown || '（无回复）',
              [],
              finalFooterMetrics,
              msg.messageId,
            );
          } else if (streaming) {
            // 已经走的 CardKit 流式：关闭 streaming_mode 并整卡更新到终态
            const finalFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
            finalFooterMetrics.status = '已完成';
            await streaming.finalize(currentFinalMarkdown || '（无回复）', finalFooterMetrics);
            streaming = null;
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
        // CardKit 2.0 流式：状态走 footer，正文不再加"运行工具中..."尾巴（loading 动画已表达进度）
        if (activeCardId && streaming) {
          const toolRunningFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          toolRunningFooterMetrics.status = `运行工具中: ${toolNames}`;
          await streaming.pushFooter(toolRunningFooterMetrics);
        } else if (activeCardId && !streaming) {
          // 老路径回退：没有 loading 动画，仍然把提示加在正文里
          const toolRunningText = `\n\n*(🔧 正在运行工具: ${toolNames}...)*`;
          const toolRunningFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          toolRunningFooterMetrics.status = `运行工具中: ${toolNames}`;
          await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (运行工具中)', renderCurrentDisplay(blocks, '', toolRunningText), toolRunningFooterMetrics);
        } else if (!activeCardId) {
          const toolRunningText = `\n\n*(🔧 正在运行工具: ${toolNames}...)*`;
          activeCardId = await gateway.sendCard(
            msg.chatId,
            'DeepV Code AI 助理 (运行工具中)',
            toolRunningText,
            [],
            await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage),
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
                      const shellFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                      shellFooterMetrics.status = '执行命令中';
                      if (streaming) {
                        await streaming.pushContent(renderCurrentDisplay(blocks, '', liveProgressMarkdown));
                        await streaming.pushFooter(shellFooterMetrics);
                      } else {
                        await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (执行命令中)', renderCurrentDisplay(blocks, '', liveProgressMarkdown), shellFooterMetrics);
                      }
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
              if (activeCardId && streaming) {
                const toolInProgressFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                toolInProgressFooterMetrics.status = `执行工具中: ${toolName}`;
                await streaming.pushContent(renderCurrentDisplay(blocks, '', liveToolProgress));
                await streaming.pushFooter(toolInProgressFooterMetrics);
              } else if (activeCardId && !streaming) {
                const toolInProgressFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                toolInProgressFooterMetrics.status = `执行工具中: ${toolName}`;
                await gateway.updateCard(activeCardId, `DeepV Code AI 助理 (执行工具中)`, renderCurrentDisplay(blocks, '', liveToolProgress), toolInProgressFooterMetrics);
              }
              toolResponse = await executeToolCall(config, req, toolRegistry, abortController.signal);
            }

            if (toolResponse.responseParts) {
              const parts = Array.isArray(toolResponse.responseParts) ? toolResponse.responseParts : [toolResponse.responseParts];
              toolResponseParts.push(...(parts as Part[]));
            }

            // 在 blocks 后面追加当前工具的最终精美运行报告
            const finalDisplayOutput = typeof toolResponse.resultDisplay === 'string'
              ? toolResponse.resultDisplay
              : JSON.stringify(toolResponse.resultDisplay, null, 2);

            const toolReportMarkdown = formatToolCallWithBorder(toolName, req.args, true, finalDisplayOutput, false);

            blocks.push({ type: 'tool', content: toolReportMarkdown });

            // 最终无打字机光标的连贯卡片更新
            if (activeCardId && streaming) {
              const toolDoneFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
              toolDoneFooterMetrics.status = `工具已完成: ${toolName}`;
              await streaming.pushContent(renderCurrentDisplay(blocks));
              await streaming.pushFooter(toolDoneFooterMetrics);
            } else if (activeCardId && !streaming) {
              const toolDoneFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
              toolDoneFooterMetrics.status = `工具已完成: ${toolName}`;
              await safeUpdateCardWithRetry(gateway, activeCardId, 'DeepV Code AI 助理', renderCurrentDisplay(blocks), toolDoneFooterMetrics);
            }

            tuiContext?.addItem(
              { type: 'info', text: tp('feishu.tui.tool_done', { name: toolName }) },
              Date.now(),
            );
          } catch (toolErr: any) {
            // 工具执行失败追加精美样式
            const failedReportMarkdown = formatToolCallWithBorder(toolName, req.args, false, toolErr.message || '未知错误', false);
            blocks.push({ type: 'tool', content: failedReportMarkdown });
            if (activeCardId) {
              const failedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
              failedFooterMetrics.status = '执行失败';
              await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (执行失败)', renderCurrentDisplay(blocks), failedFooterMetrics);
            }

            tuiContext?.addItem(
              { type: 'error', text: tp('feishu.tui.tool_failed', { name: toolName, error: toolErr.message }) },
              Date.now(),
            );
            throw toolErr;
          }
        }

        // 工具执行结束，更新状态。CardKit 2.0 流式有 loading 动画，正文不再加"思考中..."尾巴
        if (activeCardId && streaming) {
          const thinkingFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          thinkingFooterMetrics.status = '思考中';
          await streaming.pushFooter(thinkingFooterMetrics);
        } else if (activeCardId && !streaming) {
          // 老路径回退：没有 loading 动画，把提示加在正文里
          const thinkingFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          thinkingFooterMetrics.status = '思考中';
          await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (思考中)', renderCurrentDisplay(blocks) + `\n\n*(🧠 AI 正在结合工具结果继续思考...)*`, thinkingFooterMetrics);
        }

        // 将工具结果作为下一轮输入
        currentMessage = toolResponseParts;
      }

      // 达到最大轮数
      if (activeCardId && streaming) {
        const interruptedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
        interruptedFooterMetrics.status = '已中断';
        await streaming.finalize(renderCurrentDisplay(blocks) + '\n\n*（工具调用次数已达到上限）*', interruptedFooterMetrics);
        streaming = null;
      } else if (activeCardId && !streaming) {
        const interruptedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
        interruptedFooterMetrics.status = '已中断';
        await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (已中断)', renderCurrentDisplay(blocks) + '\n\n*（工具调用次数已达到上限）*', interruptedFooterMetrics);
      } else {
        await gateway.sendMessage(msg.chatId, '（工具调用次数已达到上限）', msg.messageId);
      }
      return null;
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('aborted') || err.message?.includes('cancelled') || err.message?.includes('canceled')) {
        if (activeCardId && streaming) {
          const abortedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          abortedFooterMetrics.status = '已中止';
          await streaming.finalize(renderCurrentDisplay(blocks) + '\n\n*🛑 任务已被用户中止。*', abortedFooterMetrics);
          streaming = null;
        } else if (activeCardId && !streaming) {
          const abortedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          abortedFooterMetrics.status = '已中止';
          await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (已中止)', renderCurrentDisplay(blocks) + '\n\n*🛑 任务已被用户中止。*', abortedFooterMetrics);
        }
        return null;
      }
      derror('Feishu Agent processing error:', err.message);
      const errorReply = `❌ 处理消息时出错: ${err.message}`;
      if (activeCardId && streaming) {
        const errorFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
        errorFooterMetrics.status = '出错';
        await streaming.finalize(renderCurrentDisplay(blocks) + `\n\n❌ ${err.message}`, errorFooterMetrics);
        streaming = null;
      } else if (activeCardId && !streaming) {
        const errorFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
        errorFooterMetrics.status = '出错';
        await gateway.updateCard(activeCardId, 'DeepV Code AI 助理 (出错)', renderCurrentDisplay(blocks) + `\n\n❌ ${err.message}`, errorFooterMetrics);
      }
      tuiContext?.addItem(
        { type: 'error', text: tp('feishu.tui.processing_error', { error: err.message }) },
        Date.now(),
      );
      return errorReply;
    } finally {
      activeAbortControllers.delete(msg.chatId);
      decrementProcessingCount();
    }
  }

  async function safeUpdateCardWithRetry(
    gateway: FeishuGateway,
    messageId: string,
    title: string,
    content: string,
    footerMetrics?: FeishuFooterMetrics,
    retries = 3,
    delayMs = 1000
  ): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const success = await gateway.updateCard(messageId, title, content, footerMetrics);
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
      case 'run_shell_command': return 'Bash';
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
    } else if (toolName === 'search_file_content' && args.pattern) {
      mainArg = `'${args.pattern}'`;
      if (args.glob) {
        mainArg += ` in ${args.glob}`;
      } else if (args.path) {
        mainArg += ` in ${args.path}`;
      }
    } else if (toolName === 'todo_write') {
      const todoCount = args.todos ? args.todos.length : 0;
      mainArg = todoCount > 0 ? `Update ${todoCount} items` : 'Update list';
    } else if (toolName === 'task') {
      mainArg = args.description || args.prompt || '';
    } else if (toolName === 'use_skill' && args.skillName) {
      mainArg = args.skillName;
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

    let isSubAgentDisplay = false;
    let subagentData: any = null;
    let isTodoDisplay = false;
    let todoData: any = null;

    try {
      if (output && typeof output === 'string') {
        const parsed = JSON.parse(output);
        if (parsed && parsed.type === 'subagent_display') {
          isSubAgentDisplay = true;
          subagentData = parsed;
        } else if (parsed && parsed.type === 'todo_display') {
          isTodoDisplay = true;
          todoData = parsed;
        }
      }
    } catch {
      // ignore JSON parse error
    }

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
      const oldStr = args.old_string || '';
      const newStr = args.new_string || '';
      if (oldStr || newStr) {
        const oldLines = oldStr.split('\n');
        const newLines = newStr.split('\n');

        // Compute line diff using LCS algorithm
        const m = oldLines.length;
        const n = newLines.length;
        const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

        for (let i = 1; i <= m; i++) {
          for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
              dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
              dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
          }
        }

        const diff: string[] = [];
        let i = m;
        let j = n;

        while (i > 0 || j > 0) {
          if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            diff.unshift(`  ${oldLines[i - 1]}`);
            i--;
            j--;
          } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.unshift(`+ ${newLines[j - 1]}`);
            j--;
          } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            diff.unshift(`- ${oldLines[i - 1]}`);
            i--;
          }
        }

        branchLine = `\n └ ( apply replacements completed )`;
        contentBox = `\n\`\`\`diff\n${diff.join('\n')}\n\`\`\``;
      } else {
        branchLine = `\n └ ( apply replacements completed )`;
      }
    } else if (toolName === 'write_file') {
      const content = args.content || '';
      const lines = content.split('\n');
      const totalLines = lines.length;
      const maxLinesToShow = 15;
      let displayedLines = lines;
      if (lines.length > maxLinesToShow) {
        displayedLines = lines.slice(0, maxLinesToShow);
      }

      branchLine = `\n └ ( file write completed, showing first ${displayedLines.length} lines of ${totalLines} total )`;

      const filePath = args.file_path || args.absolute_path || '';
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const lang = ['js', 'ts', 'jsx', 'tsx', 'py', 'json', 'md', 'html', 'css', 'yaml', 'yml', 'sh', 'bash'].includes(ext) ? ext : 'text';

      contentBox = `\n\`\`\`${lang}\n${displayedLines.join('\n')}\n${lines.length > maxLinesToShow ? '...\n' : ''}\`\`\``;
    } else if (toolName === 'todo_write' || isTodoDisplay) {
      const todos = args?.todos || todoData?.items;
      if (todos && Array.isArray(todos)) {
        const todoLines = [
          `📝 **${isLive ? '正在规划/更新任务清单' : '任务待办清单已更新'}**`,
          `────────────────────────`,
        ];
        todos.forEach((t: any) => {
          const statusIcon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '⏳' : '⬜';
          todoLines.push(`${statusIcon} [${t.priority}] ${t.content}`);
        });
        todoLines.push(`────────────────────────`);
        contentBox = `\n${todoLines.join('\n')}`;
      }
      branchLine = `\n └ ( update todo list completed )`;
    } else if (toolName === 'task' || isSubAgentDisplay) {
      if (subagentData) {
        const stats = subagentData.stats || {};
        const report = subagentData.report || '';
        const statsLines = [
          `📊 **子代理执行报告 (Sub-Agent Task Report)**`,
          `────────────────────────`,
          `• 任务状态: **${subagentData.status === 'success' ? '✅ 成功' : subagentData.status === 'failed' ? '❌ 失败' : '⏳ 运行中'}**`,
          `• 任务描述: ${subagentData.taskDescription || args.description || '无'}`,
          `• 执行轮数: ${subagentData.currentTurn || 0} / ${subagentData.maxTurns || args.max_turns || 10}`,
          `• 工具调用: 成功 ${stats.successfulToolCalls || 0} 次 / 共 ${stats.totalToolCalls || 0} 次`,
          stats.commandsRun && stats.commandsRun.length > 0 ? `• 运行命令: \`${stats.commandsRun.join(', ')}\`` : '',
          stats.filesCreated && stats.filesCreated.length > 0 ? `• 创建文件: \`${stats.filesCreated.join(', ')}\`` : '',
        ];
        if (subagentData.error) {
          statsLines.push(`• 错误信息: <font color='red'>${subagentData.error}</font>`);
        }
        statsLines.push(`────────────────────────`);
        if (report) {
          statsLines.push(`📝 **最终研究分析报告**:`, `\`\`\`markdown\n${report}\n\`\`\``);
        }
        contentBox = `\n${statsLines.filter(Boolean).join('\n')}`;
      } else {
        contentBox = args.prompt ? `\n\`\`\`markdown\n${args.prompt}\n\`\`\`` : '';
      }
      branchLine = isLive ? `\n └ ( sub-agent executing... )` : `\n └ ( sub-agent task completed )`;
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
    resetProcessingCount();
  };

  try {
    await gateway.connect();
    activeGateway = gateway;
    appEvents.emit(AppEvent.FeishuBotStarted);

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

  resetProcessingCount();
  await activeGateway.disconnect();
  activeGateway = null;
  appEvents.emit(AppEvent.FeishuBotStopped);
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
    appEvents.emit(AppEvent.FeishuBotStopped);
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
