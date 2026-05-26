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
import { Part, PartListUnion } from '@google/genai';

/** 当前全局网关实例（进程内单例） */
let activeGateway: FeishuGateway | null = null;

/** TUI 上下文引用（用于同步显示飞书消息到 UI） */
let tuiContext: CommandContext['ui'] | null = null;

/** 当前活跃的飞书会话信息（用于 send_feishu_file 工具发送文件） */
let activeChatId: string | null = null;
let activeReplyToMessageId: string | null = null;

/**
 * Wrapper around loadCredentials that surfaces decryption / parse errors
 * as a typed result instead of throwing — handlers can produce a friendly
 * actionable message instead of a stack trace.
 */
async function loadCredsSafe(
  projectRoot?: string,
): Promise<
  | { ok: true; creds: FeishuCredentials | null }
  | { ok: false; error: string }
> {
  try {
    const creds = await loadCredentials(projectRoot);
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
  return [
    '飞书 Bot 接入 — 让 dvcode 在飞书里回答你的问题',
    '',
    '用法:',
    '  /feishu                交互式配置并启动',
    '  /feishu setup          档 1 扫码自动建应用（推荐）',
    '  /feishu setup --manual <appId> <appSecret>  档 3 手动输入凭证',
    '  /feishu start          启动飞书 Bot（需先配置凭证）',
    '  /feishu stop           停止飞书 Bot',
    '  /feishu status         查看当前状态',
    '  /feishu logout         清除凭证并断开',
    '',
    '授权管理（重要）:',
    '  /feishu allow <openId> 允许指定飞书用户调用 Bot',
    '  /feishu deny  <openId> 移出授权白名单',
    '  /feishu allowlist      查看当前 Owner 与白名单',
    '',
    '首次使用:',
    '  1. /feishu setup              # 扫码（扫码用户自动成为 Owner）',
    '  2. /feishu start              # 启动 Bot',
    '  3. 去飞书给 Bot 发消息        # dvcode 将在后台回答',
    '',
    '⚠️  Bot 默认仅响应 Owner / 白名单中的用户，未授权用户会被拒绝。',
  ].join('\n');
}

async function handleSetup(args: string, projectRoot?: string): Promise<string> {
  const trimmed = args.trim();
  // 手动检测 --manual 模式，不走 parseArgs（避免 flag 值吃掉后续参数）
  const manualMatch = trimmed.match(/^--manual\s+(.+)$/s);
  if (manualMatch) {
    // --manual 之后的所有非空参数，以空格分割
    const rest = manualMatch[1].trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    const appId = parts[0];
    const appSecret = parts[1];
    return await handleManualSetup(appId, appSecret, projectRoot);
  }

  // 没有 --manual 则走 QR
  return await handleQrSetup(projectRoot);
}

/**
 * 档 1：扫码自动建应用
 *
 * 同步等待扫码结果（最多 expireIn 秒），结果显示在命令返回的消息中。
 * 这样可以避免 TUI 模式下后台 console.log 不可见的问题。
 */
async function handleQrSetup(projectRoot?: string): Promise<string> {
  const lines: string[] = ['📱 档 1: 扫码自动建应用'];
  lines.push('  正在连接飞书...');

  try {
    await initRegistration('feishu');
    const begin = await beginRegistration('feishu');
    const qrUrl = begin.qrUrl;

    lines.push('  二维码已生成');
    lines.push(`  URL: ${qrUrl}`);
    lines.push('');
    lines.push('  请用飞书手机 App 扫描上方二维码');
    lines.push('  或在浏览器打开链接完成授权');
    lines.push('');

    // 尝试打开浏览器
    try {
      const { default: open } = await import('open');
      open(qrUrl);
      lines.push('  → 已自动打开浏览器');
    } catch {
      lines.push('  (未能自动打开浏览器，请手动复制链接)');
    }

    lines.push('');
    lines.push('  ⏳ 正在等待扫码结果...');
    lines.push('  （按 Ctrl+C 取消等待）');

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
      lines.push('❌ 飞书扫码超时或已被取消。');
      lines.push('  输入 /feishu setup 重新开始。');
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

    await saveCredentials(creds, projectRoot);

    lines.push('');
    lines.push('✅ 飞书应用创建成功！');
    lines.push(`  App ID:      ${creds.appId}`);
    if (creds.botName) lines.push(`  Bot 名称:    ${creds.botName}`);
    lines.push(`  凭证已保存到 ${projectRoot ? projectRoot + '/.deepv/' : '~/.deepv/'}feishu-credentials.json`);
    lines.push('');
    lines.push('  下一步: 输入 /feishu start 启动 Bot');
    return lines.join('\n');
  } catch (err: any) {
    return [
      '❌ 扫码建应用失败:',
      `  ${err.message}`,
      '',
      '  可尝试 /feishu setup --manual <AppId> <AppSecret> 手动输入凭证',
    ].join('\n');
  }
}

/**
 * 档 3：手动输入凭据
 */
async function handleManualSetup(appId?: string, appSecret?: string, projectRoot?: string): Promise<string> {
  if (!appId || !appSecret) {
    return [
      '📝 档 3: 手动输入凭证',
      '',
      '  用法: /feishu setup --manual <AppId> <AppSecret>',
      '',
      '  示例: /feishu setup --manual cli_xxxxx xxxxxxxxxxxxxx',
      '',
      '  （获取方式：https://open.feishu.cn/app → 你的应用 → 凭证与基础信息）',
      '',
      '  💡 也可以先 /feishu setup 扫码自动建应用（档 1），更简单',
    ].join('\n');
  }

  // 校验凭证
  const lines: string[] = ['📝 档 3: 正在验证凭证...'];
  const botInfo = await probeCredentials(appId, appSecret, 'feishu');

  const creds: FeishuCredentials = {
    appId,
    appSecret,
    domain: 'feishu',
    botName: botInfo?.botName,
    botOpenId: botInfo?.botOpenId,
  };

  await saveCredentials(creds, projectRoot);

  lines.push(botInfo ? '  ✅ 凭证有效' : '  ⚠️ 凭证已保存但验证失败（可在开放平台检查是否已启用 Bot 能力）');
  if (creds.botName) lines.push(`  Bot 名称:    ${creds.botName}`);
  lines.push(`  凭证已保存到 ${projectRoot ? projectRoot + '/.deepv/' : '~/.deepv/'}feishu-credentials.json`);
  lines.push('');
  lines.push('  ⚠️ 手动配置模式下未自动绑定 Bot 拥有者。在 /feishu start 之后，');
  lines.push('     首次给 Bot 发消息时会拒绝并提示你将自己加入授权白名单。');
  lines.push('  下一步: 输入 /feishu start 启动 Bot');

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
      dwarn(`🛡️ 拒绝发送可疑扩展名 .${ext}: ${rawPath}`);
      continue;
    }

    // Resolve to absolute, then enforce project-root sandbox.
    const abs = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(projectRoot, rawPath);
    if (!isWithinRoot(abs, projectRoot)) {
      dwarn(`🛡️ 拒绝发送项目根目录外的文件: ${abs}`);
      continue;
    }

    try {
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      // 50 MiB cap; matches send_feishu_file tool.
      if (stat.size > 50 * 1024 * 1024) {
        dwarn(`🛡️ 拒绝发送 > 50MiB 的文件: ${abs} (${stat.size} bytes)`);
        continue;
      }

      if (IMAGE_EXTS.has(ext)) {
        const imageKey = await gateway.uploadImage(abs);
        await gateway.sendImage(chatId, imageKey, replyToMessageId);
        tuiContext?.addItem(
          { type: 'info', text: `📎 已发送图片: ${abs}` },
          Date.now(),
        );
      } else {
        const fileKey = await gateway.uploadFile(abs);
        await gateway.sendFile(chatId, fileKey, replyToMessageId);
        tuiContext?.addItem(
          { type: 'info', text: `📎 已发送文件: ${abs}` },
          Date.now(),
        );
      }
    } catch (err: unknown) {
      derror(`❌ 发送文件到飞书失败 (${abs}):`, (err as Error)?.message);
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
  const projectRoot = context?.services?.config?.getProjectRoot();
  const result = await loadCredsSafe(projectRoot);
  if (!result.ok) {
    return `❌ 读取飞书凭证失败：${result.error}\n\n如需重新配置：/feishu logout 然后 /feishu setup`;
  }
  const creds = result.creds;
  if (!creds) {
    return [
      '⚠️ 未找到飞书凭证',
      '',
      '请先配置:',
      '  /feishu setup          # 扫码自动建应用',
      '  或',
      '  /feishu setup --manual # 手动输入凭证',
    ].join('\n');
  }

  if (activeGateway) {
    return '⚠️ 飞书 Bot 已在运行中。输入 /feishu stop 停止后再启动。';
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
          text: `🛡️ 拒绝未授权消息: openId=${msg.senderOpenId} text="${messageText.slice(0, 60)}"`,
        },
        Date.now(),
      );
      return reply;
    }

    // 🎯 保存当前会话上下文（供 send_feishu_file 工具使用）
    activeChatId = msg.chatId;
    activeReplyToMessageId = msg.messageId;

    // 同步显示飞书消息到 TUI
    tuiContext?.addItem({ type: 'user', text: `[飞书] ${messageText}` }, Date.now());

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

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const stream = geminiClient.sendMessageStream(
          currentMessage,
          abortController.signal,
          promptId,
        );

        let responseText = '';
        const toolCallRequests: ToolCallRequestInfo[] = [];

        for await (const event of stream) {
          switch (event.type) {
            case GeminiEventType.Content:
              responseText += event.value;
              break;
            case GeminiEventType.ToolCallRequest:
              toolCallRequests.push(event.value);
              break;
            case GeminiEventType.ChatCompressed:
              tuiContext?.addItem({ type: 'info', text: '📦 上下文已自动压缩' }, Date.now());
              break;
            case GeminiEventType.Error:
              throw new Error(event.value?.error?.message || '未知错误');
          }
        }

        // 无工具调用 → 最终回复
        if (toolCallRequests.length === 0) {
          const replyText = responseText || '（无回复）';
          tuiContext?.addItem({ type: 'gemini', text: replyText }, Date.now());

          // 直接发送最终回复到飞书（使用 post 格式，支持 markdown 渲染）
          await gateway.sendMarkdown(msg.chatId, replyText, msg.messageId);

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

        // 工具执行
        const toolNames = toolCallRequests.map(r => r.name || 'unknown').join(', ');
        tuiContext?.addItem(
          { type: 'info', text: `🔧 执行工具: ${toolNames}` },
          Date.now(),
        );

        // 执行工具调用，收集 functionResponse
        const toolResponseParts: Part[] = [];
        for (const req of toolCallRequests) {
          const toolName = req.name || 'unknown';
          const toolArgsDesc = req.args ? JSON.stringify(req.args).slice(0, 100) : '';
          tuiContext?.addItem(
            { type: 'info', text: `🔧 执行工具: ${toolName}${toolArgsDesc ? ' ' + toolArgsDesc : ''}` },
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
                { type: 'info', text: `✅ 用户已回答问题` },
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
              { type: 'info', text: `✅ 工具完成: ${toolName}` },
              Date.now(),
            );
          } catch (toolErr: any) {
            tuiContext?.addItem(
              { type: 'error', text: `❌ 工具失败: ${toolName} — ${toolErr.message}` },
              Date.now(),
            );
            throw toolErr;
          }
        }

        // 将工具结果作为下一轮输入
        currentMessage = toolResponseParts;
      }

      // 达到最大轮数
      await gateway.sendMessage(msg.chatId, '（工具调用次数已达到上限）', msg.messageId);
      return null;
    } catch (err: any) {
      derror('❌ 飞书 Agent 处理错误:', err.message);
      const errorReply = `❌ 处理消息时出错: ${err.message}`;
      tuiContext?.addItem({ type: 'error', text: errorReply }, Date.now());
      return errorReply;
    }
  };

  gateway.onReady = () => {
    dlog('✅ 飞书 Bot 已就绪，可以开始聊天了！');
  };

  gateway.onDisconnect = () => {
    dlog('🔌 飞书连接已断开');
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
        dlog('✅ 已注册飞书文件发送工具 (send_feishu_file)');
      } catch (toolErr: any) {
        dwarn('⚠️ 注册飞书工具失败（不影响主流程）:', toolErr.message);
      }
    }

    return [
      '✅ 飞书 Bot 已启动！',
      `  Bot 名称: ${creds.botName || '(未知)'}`,
      `  连接: ${creds.domain === 'lark' ? 'Lark' : '飞书'}`,
      '',
      '  现在去飞书给 Bot 发消息试试吧 👋',
      '  输入 /feishu stop 停止',
    ].join('\n');
  } catch (err: any) {
    return `❌ 启动飞书 Bot 失败: ${err.message}`;
  }
}

/**
 * 停止网关
 */
async function handleStop(context?: CommandContext): Promise<string> {
  if (!activeGateway) {
    return '⚠️ 飞书 Bot 未运行。';
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
        dlog('✅ 已注销飞书文件发送工具 (send_feishu_file)');
      }
    } catch (toolErr: any) {
      dwarn('⚠️ 注销飞书工具失败:', toolErr.message);
    }
  }

  await activeGateway.disconnect();
  activeGateway = null;
  tuiContext = null; // 清除 TUI 上下文
  activeChatId = null;
  activeReplyToMessageId = null;
  return '🛑 飞书 Bot 已停止。';
}

/**
 * 查看状态
 */
async function handleStatus(projectRoot?: string): Promise<string> {
  const result = await loadCredsSafe(projectRoot);
  if (!result.ok) {
    return `❌ 读取飞书凭证失败：${result.error}\n\n如需重新配置：/feishu logout 然后 /feishu setup`;
  }
  const creds = result.creds;
  const lines: string[] = ['📊 飞书状态:'];

  if (creds) {
    lines.push(`  App ID:      ${creds.appId}`);
    lines.push(`  Bot 名称:    ${creds.botName || '(未知)'}`);
    lines.push(`  平台:        ${creds.domain === 'lark' ? 'Lark' : '飞书'}`);
    lines.push(`  Bot Owner:   ${creds.ownerOpenId || '(未绑定 — 首次扫码用户为 Owner)'}`);
    if (creds.allowlist && creds.allowlist.length > 0) {
      lines.push(`  授权白名单:  ${creds.allowlist.length} 人 (用 /feishu allowlist 查看)`);
    }
  } else {
    lines.push('  凭证:        未配置');
    lines.push('');
    lines.push('  请运行 /feishu setup 配置凭证');
    return lines.join('\n');
  }

  lines.push(`  Bot 状态:     ${activeGateway ? '🟢 运行中' : '🔴 已停止'}`);

  if (!activeGateway) {
    lines.push('');
    lines.push('  运行 /feishu start 启动 Bot');
  }

  return lines.join('\n');
}

/**
 * 添加 open_id 到授权白名单（B1 — 授权管理）
 *
 * 用法：/feishu allow <openId>
 */
async function handleAllow(args: string, projectRoot?: string): Promise<string> {
  const openId = args.trim();
  if (!openId) {
    return [
      '用法: /feishu allow <openId>',
      '',
      '允许指定 open_id 的飞书用户向 Bot 发送消息并触发 LLM/工具调用。',
      'open_id 可在 Bot 拒绝消息时的提示中找到，或在飞书开放平台 → 通讯录中查询。',
    ].join('\n');
  }
  let creds: FeishuCredentials | null;
  try {
    creds = await loadCredentials(projectRoot);
  } catch (e) {
    return `❌ 读取凭证失败: ${(e as Error).message}`;
  }
  if (!creds) {
    return '⚠️ 未找到飞书凭证。请先运行 /feishu setup。';
  }
  // owner 已是该 openId 时无需再加
  if (creds.ownerOpenId === openId) {
    return `ℹ️ ${openId} 已是 Bot Owner，无需加入白名单。`;
  }
  // 如果 owner 未绑定，把这个 openId 设为 owner
  if (!creds.ownerOpenId) {
    creds.ownerOpenId = openId;
    await saveCredentials(creds, projectRoot);
    return `✅ 已将 ${openId} 设为 Bot Owner。`;
  }
  const list = new Set(creds.allowlist ?? []);
  if (list.has(openId)) {
    return `ℹ️ ${openId} 已在授权白名单中。`;
  }
  list.add(openId);
  creds.allowlist = [...list];
  await saveCredentials(creds, projectRoot);
  return `✅ 已将 ${openId} 加入授权白名单 (共 ${creds.allowlist.length} 人)。`;
}

/**
 * 从授权白名单移除 open_id（B1 — 授权管理）
 *
 * 用法：/feishu deny <openId>
 */
async function handleDeny(args: string, projectRoot?: string): Promise<string> {
  const openId = args.trim();
  if (!openId) {
    return '用法: /feishu deny <openId>';
  }
  let creds: FeishuCredentials | null;
  try {
    creds = await loadCredentials(projectRoot);
  } catch (e) {
    return `❌ 读取凭证失败: ${(e as Error).message}`;
  }
  if (!creds) {
    return '⚠️ 未找到飞书凭证。请先运行 /feishu setup。';
  }
  if (creds.ownerOpenId === openId) {
    return [
      `❌ 不能直接移除 Bot Owner (${openId})。`,
      '',
      '如需更换 Owner，请：',
      '  1. /feishu allow <new-owner-openId> 先把新 Owner 加入白名单',
      '  2. /feishu logout 清除全部凭证后重新 setup',
    ].join('\n');
  }
  const before = creds.allowlist?.length ?? 0;
  creds.allowlist = (creds.allowlist ?? []).filter((id) => id !== openId);
  if (creds.allowlist.length === before) {
    return `ℹ️ ${openId} 不在授权白名单中。`;
  }
  await saveCredentials(creds, projectRoot);
  return `✅ 已将 ${openId} 移出授权白名单 (剩余 ${creds.allowlist.length} 人)。`;
}

/**
 * 列出授权白名单（B1 — 授权管理）
 */
async function handleAllowlist(projectRoot?: string): Promise<string> {
  let creds: FeishuCredentials | null;
  try {
    creds = await loadCredentials(projectRoot);
  } catch (e) {
    return `❌ 读取凭证失败: ${(e as Error).message}`;
  }
  if (!creds) {
    return '⚠️ 未找到飞书凭证。请先运行 /feishu setup。';
  }
  const lines = ['🛡️ 飞书 Bot 授权列表:'];
  lines.push(`  Owner:       ${creds.ownerOpenId || '(未绑定)'}`);
  if (creds.allowlist && creds.allowlist.length > 0) {
    lines.push('  白名单:');
    for (const id of creds.allowlist) {
      lines.push(`    - ${id}`);
    }
  } else {
    lines.push('  白名单:      (空)');
  }
  lines.push('');
  lines.push('管理: /feishu allow <openId>  /  /feishu deny <openId>');
  return lines.join('\n');
}

/**
 * 清除凭证
 */
async function handleLogout(projectRoot?: string, context?: CommandContext): Promise<string> {
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
  await clearCredentials(projectRoot);
  return '🗑️ 飞书凭证已清除，Bot 已断开。';
}

/**
 * 交互式主入口
 */
async function handleInteractive(projectRoot?: string): Promise<string> {
  const result = await loadCredsSafe(projectRoot);
  if (!result.ok) {
    return `❌ 读取飞书凭证失败：${result.error}\n\n如需重新配置：/feishu logout 然后 /feishu setup`;
  }
  const creds = result.creds;

  if (!creds) {
    // 未配置，引导 setup
    return [
      '👋 欢迎使用飞书 Bot！',
      '',
      '  首次使用，请先配置凭证:',
      '    /feishu setup          # 扫码自动建应用（推荐）',
      '    /feishu setup --manual # 手动输入凭证',
      '',
      '  或输入 /feishu help 查看帮助',
    ].join('\n');
  }

  if (!activeGateway) {
    return [
      '✅ 凭证已配置',
      `  App ID: ${creds.appId}`,
      `  Bot:    ${creds.botName || '(未知)'}`,
      '',
      '  输入 /feishu start 启动 Bot',
      '  输入 /feishu logout 清除凭证',
    ].join('\n');
  }

  return '✅ 飞书 Bot 正在运行中。输入 /feishu stop 停止。';
}

/** 通用 MessageActionReturn 包装 */
function msg(content: string): SlashCommandActionReturn {
  return { type: 'message', messageType: 'info', content };
}

export const feishuCommand: SlashCommand = {
  name: 'feishu',
  altNames: ['飞书'],
  description: '接入飞书 Bot，让 dvcode 在飞书里回答代码问题',
  kind: CommandKind.BUILT_IN,

  // /feishu（无子命令）→ 显示帮助
  action: async (ctx) => {
    const pr = ctx.services?.config?.getProjectRoot();
    return msg(await handleInteractive(pr));
  },

  subCommands: [
    {
      name: 'setup',
      description: '配置飞书应用凭证（扫码或手动输入）',
      kind: CommandKind.BUILT_IN,
      action: async (ctx, args) => {
        const pr = ctx.services?.config?.getProjectRoot();
        return msg(await handleSetup(args, pr));
      },
    },
    {
      name: 'start',
      description: '启动飞书 Bot（WS 长连接）',
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => msg(await handleStart(ctx)),
    },
    {
      name: 'stop',
      description: '停止飞书 Bot',
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => {
        return msg(await handleStop(ctx));
      },
    },
    {
      name: 'status',
      description: '查看飞书 Bot 连接状态',
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => {
        const pr = ctx.services?.config?.getProjectRoot();
        return msg(await handleStatus(pr));
      },
    },
    {
      name: 'logout',
      description: '清除飞书凭证并断开连接',
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => {
        const pr = ctx.services?.config?.getProjectRoot();
        return msg(await handleLogout(pr, ctx));
      },
    },
    {
      name: 'allow',
      description: '将飞书 open_id 加入授权白名单',
      kind: CommandKind.BUILT_IN,
      action: async (ctx, args) => {
        const pr = ctx.services?.config?.getProjectRoot();
        return msg(await handleAllow(args, pr));
      },
    },
    {
      name: 'deny',
      description: '从授权白名单中移除指定 open_id',
      kind: CommandKind.BUILT_IN,
      action: async (ctx, args) => {
        const pr = ctx.services?.config?.getProjectRoot();
        return msg(await handleDeny(args, pr));
      },
    },
    {
      name: 'allowlist',
      description: '列出当前 Bot 的 Owner 与授权白名单',
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => {
        const pr = ctx.services?.config?.getProjectRoot();
        return msg(await handleAllowlist(pr));
      },
    },
    {
      name: 'help',
      description: '显示飞书帮助',
      kind: CommandKind.BUILT_IN,
      action: async () => msg(helpText()),
    },
  ],
};
