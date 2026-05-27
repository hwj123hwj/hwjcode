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

import { CommandKind, SlashCommand, SlashCommandActionReturn, CommandContext } from './types.js';
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
  executeToolCall,
  ToolRegistry,
  GeminiEventType,
  ToolCallRequestInfo,
  SessionManager,
  isWithinRoot,
} from 'deepv-code-core';
import { dlog, dwarn, derror } from '../../services/feishu/logger.js';
import { t, tp } from '../utils/i18n.js';
import { Part, PartListUnion } from '@google/genai';

/** 当前全局网关实例（进程内单例） */
let activeGateway: FeishuGateway | null = null;

/** TUI 上下文引用（用于同步显示飞书消息到 UI） */
let tuiContext: CommandContext['ui'] | null = null;

/** 当前活跃的飞书会话信息（用于 send_feishu_file 工具发送文件） */
let activeChatId: string | null = null;
let activeReplyToMessageId: string | null = null;

interface QueuedMessage {
  msg: FeishuMessage;
  resolve: (value: any) => void;
  reject: (err: any) => void;
}

const messageQueue: QueuedMessage[] = [];
let isProcessingQueue = false;

function clearMessageQueue() {
  for (const item of messageQueue) {
    item.resolve(null);
  }
  messageQueue.length = 0;
  isProcessingQueue = false;
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

async function handleSetup(args: string): Promise<string> {
  const trimmed = args.trim();
  // 手动检测 --manual 模式，不走 parseArgs（避免 flag 值吃掉后续参数）
  const manualMatch = trimmed.match(/^--manual\s+(.+)$/s);
  if (manualMatch) {
    // --manual 之后的所有非空参数，以空格分割
    const rest = manualMatch[1].trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    const appId = parts[0];
    const appSecret = parts[1];
    return await handleManualSetup(appId, appSecret);
  }

  // 没有 --manual 则走 QR
  return await handleQrSetup();
}

/**
 * 档 1：扫码自动建应用
 *
 * 同步等待扫码结果（最多 expireIn 秒），结果显示在命令返回的消息中。
 * 这样可以避免 TUI 模式下后台 console.log 不可见的问题。
 */
async function handleQrSetup(): Promise<string> {
  const lines: string[] = [t('feishu.setup.qr.title')];
  lines.push(t('feishu.setup.qr.connecting'));

  try {
    await initRegistration('feishu');
    const begin = await beginRegistration('feishu');
    const qrUrl = begin.qrUrl;

    lines.push(t('feishu.setup.qr.generated'));
    lines.push(tp('feishu.setup.qr.url', { url: qrUrl }));
    lines.push('');
    lines.push(t('feishu.setup.qr.scan_hint'));
    lines.push(t('feishu.setup.qr.browser_hint'));
    lines.push('');

    // 尝试打开浏览器
    try {
      const { default: open } = await import('open');
      open(qrUrl);
      lines.push(t('feishu.setup.qr.browser_opened'));
    } catch {
      lines.push(t('feishu.setup.qr.browser_failed'));
    }

    lines.push('');
    lines.push(t('feishu.setup.qr.waiting'));
    lines.push(t('feishu.setup.qr.cancel_hint'));

    // 同步等待扫码结果（带进度点回调）
    let dots = '';
    const pollResult = await pollRegistration(
      begin.deviceCode,
      begin.interval,
      begin.expireIn,
      'feishu',
      (d) => { dots = d; },
    );

    if (!pollResult) {
      lines.push('');
      lines.push(t('feishu.setup.qr.timeout'));
      lines.push(t('feishu.setup.qr.retry_hint'));
      return lines.join('\n');
    }

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

    lines.push('');
    lines.push(t('feishu.setup.qr.success'));
    lines.push(`  App ID:      ${creds.appId}`);
    if (creds.botName) lines.push(tp('feishu.setup.qr.bot_name', { name: creds.botName }));
    lines.push(t('feishu.setup.qr.creds_saved'));
    lines.push('');
    lines.push(t('feishu.setup.qr.next_step_start'));
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
 * 档 3：手动输入凭据
 */
async function handleManualSetup(appId?: string, appSecret?: string): Promise<string> {
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

  // 获取 GeminiClient
  const config = context?.services?.config;
  const geminiClient = config?.getGeminiClient?.();

  // 设置消息处理 — 使用主会话的 agent 模式（带工具执行能力）
  gateway.onMessage = async (msg: FeishuMessage): Promise<string | null> => {
    const messageText = typeof msg.text === 'string' ? msg.text.trim() : '';
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

    // 如果当前正在处理，或者队列中已有消息，则提示用户排队
    if (isProcessingQueue || messageQueue.length > 0) {
      const queuePosition = messageQueue.length + 1;
      const queueTip = `⏳ *当前任务正在处理中，您的消息已加入排队队列（当前处于第 ${queuePosition} 位）...*`;
      await gateway.sendMessage(msg.chatId, queueTip, msg.messageId);
    }

    return new Promise<string | null>((resolve, reject) => {
      messageQueue.push({ msg, resolve, reject });
      processMessageQueue(gateway, config, geminiClient, creds);
    });
  };

  async function handleSingleFeishuMessage(
    msg: FeishuMessage,
    gateway: FeishuGateway,
    config: any,
    geminiClient: any,
    creds: FeishuCredentials,
  ): Promise<string | null> {
    const messageText = typeof msg.text === 'string' ? msg.text.trim() : '';

    // 🎯 保存当前会话上下文（供 send_feishu_file 工具使用）
    activeChatId = msg.chatId;
    activeReplyToMessageId = msg.messageId;

    // 同步显示飞书消息到 TUI
    tuiContext?.addItem(
      { type: 'user', text: tp('feishu.tui.incoming_prefix', { text: messageText }) },
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
      const noLlmReply = '⚠️ LLM 未初始化，无法回答。请先在 dvcode 中配置好模型。';
      tuiContext?.addItem({ type: 'info', text: noLlmReply }, Date.now());
      return noLlmReply;
    }

    const toolRegistry: ToolRegistry = await config.getToolRegistry();
    const abortController = new AbortController();
    const promptId = `feishu-${Date.now()}`;

    try {
      // 确保 chat 已初始化
      await geminiClient.waitForChatInitialized();

      // Agent 循环：和 TUI 共享同一个会话，走 geminiClient.sendMessageStream
      let currentMessage: PartListUnion = messageText;
      const MAX_TURNS = 100;

      let activeCardId: string | null = null;
      let accumulatedMarkdown = '';

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
              const currentTotalMarkdown = accumulatedMarkdown + responseText;
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
        accumulatedMarkdown += responseText;

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
            accumulatedMarkdown,
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

            const toolResponse = await executeToolCall(config, req, toolRegistry, abortController.signal);
            if (toolResponse.responseParts) {
              const parts = Array.isArray(toolResponse.responseParts) ? toolResponse.responseParts : [toolResponse.responseParts];
              toolResponseParts.push(...(parts as Part[]));
            }
            tuiContext?.addItem(
              { type: 'info', text: tp('feishu.tui.tool_done', { name: toolName }) },
              Date.now(),
            );
          } catch (toolErr: any) {
            tuiContext?.addItem(
              { type: 'error', text: tp('feishu.tui.tool_failed', { name: toolName, error: toolErr.message }) },
              Date.now(),
            );
            throw toolErr;
          }
        }

        // 工具执行结束，更新状态
        if (activeCardId) {
          await gateway.updateCard(activeCardId, 'DeepV Code AI 助理', accumulatedMarkdown + `\n\n*(✅ 工具运行完成，正在继续思考...)*`);
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
      derror('Feishu Agent processing error:', err.message);
      const errorReply = `❌ 处理消息时出错: ${err.message}`;
      tuiContext?.addItem(
        { type: 'error', text: tp('feishu.tui.processing_error', { error: err.message }) },
        Date.now(),
      );
      return errorReply;
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

  async function processMessageQueue(
    gateway: FeishuGateway,
    config: any,
    geminiClient: any,
    creds: FeishuCredentials,
  ) {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
      while (messageQueue.length > 0) {
        const item = messageQueue.shift();
        if (!item) continue;

        const { msg, resolve, reject } = item;
        try {
          const result = await handleSingleFeishuMessage(msg, gateway, config, geminiClient, creds);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }
    } finally {
      isProcessingQueue = false;
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
        await geminiClient.setTools();
        dlog('Registered Feishu file-send tool (send_feishu_file)');
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

  // 🎯 动态注销 send_feishu_file 工具
  const config = context?.services?.config;
  const geminiClient = config?.getGeminiClient?.();
  if (config && geminiClient) {
    try {
      const toolRegistry: ToolRegistry = await config.getToolRegistry();
      const removed = toolRegistry.unregisterTool(SendFeishuFileTool.Name);
      if (removed) {
        await geminiClient.setTools();
        dlog('Unregistered Feishu file-send tool (send_feishu_file)');
      }
    } catch (toolErr: any) {
      dwarn('Failed to unregister Feishu tool:', toolErr.message);
    }
  }

  clearMessageQueue();

  await activeGateway.disconnect();
  activeGateway = null;
  tuiContext = null; // 清除 TUI 上下文
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
      action: async (_ctx, args) => msg(await handleSetup(args)),
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
