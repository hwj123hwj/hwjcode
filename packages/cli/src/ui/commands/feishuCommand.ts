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
import { loadCredentials, saveCredentials, clearCredentials, FeishuCredentials } from '../../services/feishu/credentials.js';
import {
  initRegistration,
  beginRegistration,
  pollRegistration,
  probeCredentials,
} from '../../services/feishu/registration.js';
import { FeishuGateway, FeishuMessage } from '../../services/feishu/gateway.js';
import { SceneType } from 'deepv-code-core';
import { HistoryItemWithoutId } from '../types.js';

/** 当前全局网关实例（进程内单例） */
let activeGateway: FeishuGateway | null = null;

/** TUI 上下文引用（用于同步显示飞书消息到 UI） */
let tuiContext: CommandContext['ui'] | null = null;

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
    '首次使用:',
    '  1. /feishu setup              # 扫码或手动配凭证',
    '  2. /feishu start              # 启动 Bot',
    '  3. 去飞书给 Bot 发消息        # dvcode 将在后台回答',
  ].join('\n');
}

/**
 * 解析命令参数
 */
function parseArgs(args: string): { subcommand: string; flags: Record<string, string | boolean | string[]> } {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0] || '';
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  let i = 1;
  while (i < parts.length) {
    const p = parts[i];
    if (p.startsWith('--')) {
      const key = p.slice(2);
      // 如果下一个参数不是 -- 开头，则作为值
      if (i + 1 < parts.length && !parts[i + 1].startsWith('--')) {
        flags[key] = parts[i + 1];
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(p);
      i += 1;
    }
  }
  if (positional.length > 0) {
    flags._ = positional;
  }
  return { subcommand, flags };
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
    };

    await saveCredentials(creds);

    lines.push('');
    lines.push('✅ 飞书应用创建成功！');
    lines.push(`  App ID:      ${creds.appId}`);
    if (creds.botName) lines.push(`  Bot 名称:    ${creds.botName}`);
    lines.push('  凭证已保存到 ~/.deepv/feishu-credentials.json');
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
async function handleManualSetup(appId?: string, appSecret?: string): Promise<string> {
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

  await saveCredentials(creds);

  lines.push(botInfo ? '  ✅ 凭证有效' : '  ⚠️ 凭证已保存但验证失败（可在开放平台检查是否已启用 Bot 能力）');
  if (creds.botName) lines.push(`  Bot 名称:    ${creds.botName}`);
  lines.push('  凭证已保存到 ~/.deepv/feishu-credentials.json');
  lines.push('');
  lines.push('  下一步: 输入 /feishu start 启动 Bot');

  return lines.join('\n');
}

/**
 * 启动网关（从已保存的凭证）
 */
async function handleStart(context?: CommandContext): Promise<string> {
  const creds = await loadCredentials();
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

  // 设置消息处理
  gateway.onMessage = async (msg: FeishuMessage): Promise<string | null> => {
    // 调试：直接返回调试信息
    const debugInfo = [
      `[DEBUG] msg.text type: ${typeof msg.text}`,
      `[DEBUG] msg.text value: ${JSON.stringify(msg.text)}`,
      `[DEBUG] msg.text constructor: ${(msg.text as any)?.constructor?.name}`,
    ].join('\n');
    console.log(debugInfo);

    // 防御性检查：确保消息文本是有效字符串
    const messageText = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!messageText) {
      console.log('⏭️ 跳过空消息');
      return null;
    }

    // 同步显示飞书消息到 TUI
    const feishuUserMsg: HistoryItemWithoutId = {
      type: 'user',
      text: `[飞书] ${messageText}`,
    };
    tuiContext?.addItem(feishuUserMsg, Date.now());

    if (!geminiClient) {
      const noLlmReply = `收到你的消息: "${messageText}"\n\n(消息 ID: ${msg.messageId.slice(0, 8)}...)\n\n⚠️ LLM 未初始化，无法回答。请先在 dvcode 中配置好模型。`;
      // 同步显示错误到 TUI
      tuiContext?.addItem({ type: 'info', text: noLlmReply }, Date.now());
      return noLlmReply;
    }

    try {
      // 用 createTemporaryChat，禁用 system prompt 以避免继承 agent 工具
      const chat = await geminiClient.createTemporaryChat(
        SceneType.SUB_AGENT,
        undefined,
        undefined,
        { disableSystemPrompt: true },
      );

      // 移除工具声明，确保 LLM 只做纯文本回复
      chat.setTools([]);

      // 确保是纯字符串
      const safeMessage = String(messageText);

      const response = await chat.sendMessage(
        { message: safeMessage },
        `feishu-${Date.now()}`,
        SceneType.SUB_AGENT,
      );
      // 提取回复文本（过滤掉 functionCall）
      const textParts = response.candidates?.[0]?.content?.parts
        ?.filter((p: any) => p.text)
        .map((p: any) => p.text) || [];
      const replyText = textParts.join('') || '（无回复）';

      // 同步显示 LLM 回复到 TUI
      tuiContext?.addItem({ type: 'gemini', text: replyText }, Date.now());

      return replyText;
    } catch (err: any) {
      console.error('❌ 飞书 LLM 回答错误:', err.message);
      console.error('❌ 错误堆栈:', err.stack);

      // 把完整错误信息显示在 TUI 和返回给飞书
      const errorReply = `❌ 处理消息时出错: ${err.message}\n\n堆栈:\n${err.stack?.slice(0, 500) || '无'}`;
      tuiContext?.addItem({ type: 'error', text: errorReply }, Date.now());
      return errorReply;
    }
  };

  gateway.onReady = () => {
    console.log('✅ 飞书 Bot 已就绪，可以开始聊天了！');
  };

  gateway.onDisconnect = () => {
    console.log('🔌 飞书连接已断开');
  };

  try {
    await gateway.connect();
    activeGateway = gateway;
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
async function handleStop(): Promise<string> {
  if (!activeGateway) {
    return '⚠️ 飞书 Bot 未运行。';
  }

  await activeGateway.disconnect();
  activeGateway = null;
  tuiContext = null; // 清除 TUI 上下文
  return '🛑 飞书 Bot 已停止。';
}

/**
 * 查看状态
 */
async function handleStatus(): Promise<string> {
  const creds = await loadCredentials();
  const lines: string[] = ['📊 飞书状态:'];

  if (creds) {
    lines.push(`  App ID:      ${creds.appId}`);
    lines.push(`  Bot 名称:    ${creds.botName || '(未知)'}`);
    lines.push(`  平台:        ${creds.domain === 'lark' ? 'Lark' : '飞书'}`);
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
 * 清除凭证
 */
async function handleLogout(): Promise<string> {
  if (activeGateway) {
    await activeGateway.disconnect();
    activeGateway = null;
  }
  tuiContext = null; // 清除 TUI 上下文
  await clearCredentials();
  return '🗑️ 飞书凭证已清除，Bot 已断开。';
}

/**
 * 交互式主入口
 */
async function handleInteractive(): Promise<string> {
  const creds = await loadCredentials();

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

/**
 * 主分发
 */
async function feishuAction(_context: any, args: string): Promise<SlashCommandActionReturn | void> {
  const trimmed = args.trim();
  const { subcommand } = parseArgs(trimmed);

  let output: string;

  switch (subcommand) {
    case 'setup':
      output = await handleSetup(args.replace(/^setup\s*/i, ''));
      break;
    case 'start':
      output = await handleStart(_context);
      break;
    case 'stop':
      output = await handleStop();
      break;
    case 'status':
      output = await handleStatus();
      break;
    case 'logout':
      output = await handleLogout();
      break;
    case 'help':
    case '--help':
    case '-h':
      output = helpText();
      break;
    case '':
      output = await handleInteractive();
      break;
    default:
      output = `未知子命令: ${subcommand}\n\n${helpText()}`;
  }

  return {
    type: 'message',
    messageType: 'info',
    content: output,
  };
}

export const feishuCommand: SlashCommand = {
  name: 'feishu',
  altNames: ['飞书'],
  description: '接入飞书 Bot，让 dvcode 在飞书里回答代码问题',
  kind: CommandKind.BUILT_IN,
  action: feishuAction,
  // ⚠ 不设置 subCommands：框架的 subCommand 匹配会吃掉子命令名，导致 args 不完整。
  // feishuAction 内部的 parseArgs 自己处理子命令解析。
};
