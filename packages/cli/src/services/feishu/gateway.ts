/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书消息网关 — 基于 @larksuiteoapi/node-sdk WSClient 的长连接收发消息
 *
 * SDK 内部处理：
 *   - 两步握手：POST /callback/ws/endpoint 获取动态 WS URL → 建立 WebSocket
 *   - Protobuf 帧编码/解码 + 分片合并（seq/sum）
 *   - 控制帧（ping/pong）与数据帧（事件）分离
 *   - 自动重连（指数退避）
 *   - EventDispatcher 事件分发
 *
 * 收到消息 → 调 onMessage 回调 → 发回复走 REST API
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { dlog, dwarn, derror } from './logger.js';
import { optimizeMarkdownStyle } from './markdown-style.js';
import { detectImageExtension } from './image-type.js';

const API_BASE_URLS: Record<string, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

/**
 * 卡片交互（等待用户点击/提交）的默认超时时间（毫秒）。
 *
 * 飞书侧无法像 CLI 终端那样真正无限期等待用户（常驻 Promise 会占内存、上游
 * AI 任务会僵死），因此给一个很长但有限的默认值：30 分钟。调用方可按需覆盖。
 */
const DEFAULT_CARD_ACTION_TIMEOUT_MS = 30 * 60 * 1000;

export interface FeishuMessage {
  text: string;
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group' | 'topic';
  senderOpenId: string;
  mentions: Array<{ key: string; openId: string }>;
  messageType: string;
  /** 待下载的图片信息（不在 gateway 中直接下载，留给 feishuCommand 在确定 projectRoot 后下载到 .deepvcode/clipboard/） */
  pendingImages?: Array<{ imageKey: string; placeholder: string }>;
}

export type OnMessageCallback = (msg: FeishuMessage) => Promise<string | null>;

/** 卡片按钮点击回调的数据 */
export interface CardActionData {
  /** 用户点击的按钮 value */
  value: string;
  /** 用户的 open_id */
  openId: string;
  /** 触发回调的消息 message_id */
  messageId: string;
  /**
   * 表单提交时（form_action.type = 'submit'）携带的所有具名组件的值。
   * 键为组件的 `name`，值为单选选中的 value（string）、复选选中的 value 数组（string[]）或输入框文本（string）。
   * 非表单（普通按钮点击）时为 undefined。
   */
  formValue?: Record<string, string | string[]>;
}

export type OnCardActionCallback = (data: CardActionData) => void;

/** 单个问题的选项 */
export interface FeishuQuestionOption {
  label: string;
  description?: string;
}

/** 提交给表单卡片的单个问题 */
export interface FeishuQuestion {
  /** 问题正文 */
  question: string;
  /** 短标题（可选，显示在下拉框 label 上） */
  header?: string;
  /** 候选项（2-4 个） */
  options: FeishuQuestionOption[];
  /** 是否允许多选（保留字段，当前下拉为单选 + 自定义填空） */
  multiSelect?: boolean;
}

/** 表单卡片回答结果：key 为问题文本，value 为用户的最终答案文本 */
export type FeishuQuestionAnswers = Record<string, string>;

/** 飞书卡片页脚指标 */
export interface FeishuFooterMetrics {
  status?: string; // 例如: "Completed", "Error", "Processing"
  elapsedMs?: number; // 耗时 (毫秒)
  tokens?: { input: number; output: number }; // Token 使用量
  contextPercentage?: number; // 上下文剩余百分比
  model?: string; // 使用的模型名称
  cacheRead?: number; // 缓存读取 tokens 数
  cacheHitRate?: number; // 缓存命中百分比 (0-100)
  credits?: number; // 扣减点数
}

/** CardKit 2.0 流式卡片中正文的固定 element_id */
export const CARDKIT_STREAMING_ELEMENT_ID = 'streaming_content';

/** CardKit 2.0 流式卡片中页脚的固定 element_id */
export const CARDKIT_FOOTER_ELEMENT_ID = 'footer_content';

/** CardKit 2.0 流式卡片中 loading 图标的固定 element_id（终态由整卡覆盖移除） */
export const CARDKIT_LOADING_ELEMENT_ID = 'loading_icon';

/**
 * 飞书内置 loading 动画 img_key（与 openclaw-lark 插件一致）。
 *
 * 这个 img_key 是飞书官方提供给 streaming 卡片的转圈图标资源。
 * 只要 streaming_mode = true 且卡片里有这个图标元素，客户端就会自动渲染打字机
 * 加载视觉，不需要再在正文里写"思考中..."、"运行工具中..."之类的提示尾巴。
 */
const CARDKIT_LOADING_IMG_KEY = 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg';

/**
 * 格式化毫秒数为人类可读的持续时间字符串。
 */
function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * 把 footer metrics 渲染为单行 markdown 文本，供 CardKit 2.0 的 footer
 * markdown 元素直接作为 content 使用。
 */
export function renderFooterMarkdown(metrics: FeishuFooterMetrics): string {
  const parts: string[] = [];
  let isError = false;

  if (metrics.status) {
    let statusText = metrics.status;
    const lower = metrics.status.toLowerCase();
    if (lower.includes('error') || lower.includes('failed') || lower.includes('出错') || lower.includes('失败')) {
      statusText = `<font color='red'>${metrics.status}</font>`;
      isError = true;
    } else if (lower.includes('processing') || lower.includes('thinking') || lower.includes('思考中') || lower.includes('运行')) {
      statusText = `<font color='grey'>${metrics.status}</font>`;
    } else {
      statusText = `<font color='green'>${metrics.status}</font>`;
    }
    parts.push(statusText);
  }

  if (metrics.elapsedMs != null) {
    parts.push(`耗时 ${formatElapsed(metrics.elapsedMs)}`);
  }

  if (metrics.model) {
    parts.push(metrics.model);
  }

  if (metrics.tokens) {
    parts.push(`↑${metrics.tokens.input.toLocaleString()} ↓${metrics.tokens.output.toLocaleString()}`);
  }

  if (metrics.cacheRead != null && metrics.cacheRead > 0) {
    let cacheText = `缓存读取 ${metrics.cacheRead.toLocaleString()}`;
    if (metrics.cacheHitRate != null && metrics.cacheHitRate > 0) {
      cacheText += ` (${metrics.cacheHitRate.toFixed(1)}%)`;
    }
    parts.push(cacheText);
  }

  if (metrics.contextPercentage != null) {
    const remainingPercentage = Math.max(0, 100 - metrics.contextPercentage);
    parts.push(`上下文剩余 ${remainingPercentage.toFixed(0)}%`);
  }

  if (parts.length === 0) return '';
  const text = parts.join(' · ');
  return isError ? `<font color='red'>${text}</font>` : text;
}

/**
 * 构建一个标准飞书卡片页脚元素数组（旧版 1.x 卡片用）。
 * 新版 CardKit 2.0 的卡片直接走 renderFooterMarkdown + 单 markdown 元素。
 */
function buildFeishuFooterElements(metrics: FeishuFooterMetrics): any[] {
  const content = renderFooterMarkdown(metrics);
  if (!content) return [];
  return [
    {
      tag: 'hr',
    },
    {
      tag: 'markdown',
      content,
    },
  ];
}

/**
 * 构建 CardKit 2.0 流式起始卡片（schema 2.0）。
 *
 * 包含：
 *   - 一个 markdown 元素（element_id=streaming_content）作为流式正文容器
 *   - 一个 markdown 元素（element_id=footer_content）作为可独立流式更新的页脚
 *   - 一个 loading 图标元素（element_id=loading_icon），streaming_mode 期间自动转圈
 *
 * 说明：飞书 CardKit 2.0 的流式打字机效果，必须满足
 *   1) config.streaming_mode = true
 *   2) 通过 cardkit.v1.cardElement.content() 接口（PUT 增量）只更新某个 element
 *   3) 调用 sequence 单调递增
 *   4) loading_icon 元素的存在让客户端显示加载动画 — 终态用 card.update 整卡
 *      覆盖时不再带这个元素，动画即自动消失（不需要主动 PATCH 移除）
 */
export function buildCardKitStreamingCard(initialContent: string = '', initialFooter: string = ''): Record<string, any> {
  const elements: any[] = [
    {
      tag: 'markdown',
      element_id: CARDKIT_STREAMING_ELEMENT_ID,
      content: initialContent ? optimizeMarkdownStyle(initialContent, 2) : ' ',
      text_align: 'left',
      text_size: 'normal_v2',
    },
    // loading 转圈图标 — 与 openclaw-lark 一致
    {
      tag: 'markdown',
      element_id: CARDKIT_LOADING_ELEMENT_ID,
      content: ' ',
      icon: {
        tag: 'custom_icon',
        img_key: CARDKIT_LOADING_IMG_KEY,
        size: '16px 16px',
      },
    },
  ];
  if (initialFooter) {
    elements.push({
      tag: 'markdown',
      element_id: CARDKIT_FOOTER_ELEMENT_ID,
      content: initialFooter,
      text_size: 'notation',
    });
  } else {
    // 占位 footer，方便后续 streamCardElement 直接更新
    elements.push({
      tag: 'markdown',
      element_id: CARDKIT_FOOTER_ELEMENT_ID,
      content: ' ',
      text_size: 'notation',
    });
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: {
        content: 'Processing...',
        i18n_content: { zh_cn: '处理中...', en_us: 'Processing...' },
      },
    },
    body: { elements },
  };
}

/**
 * 构建 CardKit 2.0 终态卡片（streaming_mode 关闭后用 card.update 整卡覆盖）。
 */
export function buildCardKitFinalCard(content: string, footerMetrics?: FeishuFooterMetrics, headerTitle?: string): Record<string, any> {
  const elements: any[] = [
    {
      tag: 'markdown',
      element_id: CARDKIT_STREAMING_ELEMENT_ID,
      content: content ? optimizeMarkdownStyle(content, 2) : ' ',
      text_align: 'left',
      text_size: 'normal_v2',
    },
  ];

  const footerContent = footerMetrics ? renderFooterMarkdown(footerMetrics) : '';
  if (footerContent) {
    elements.push({
      tag: 'markdown',
      element_id: CARDKIT_FOOTER_ELEMENT_ID,
      content: footerContent,
      text_size: 'notation',
    });
  }

  // 用文本前 120 字符做 feed summary（去掉 markdown 符号）
  const summaryText = content.replace(/[*_`#>[\]()~]/g, '').trim().slice(0, 120) || 'Done';

  const card: Record<string, any> = {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: summaryText },
    },
    body: { elements },
  };

  if (headerTitle) {
    card.header = {
      title: { tag: 'plain_text', content: headerTitle },
      template: 'blue',
    };
  }
  return card;
}

/**
 * 飞书 WS 网关（基于 @larksuiteoapi/node-sdk）
 *
 * 用法：
 *   const gw = new FeishuGateway(appId, appSecret);
 *   gw.onMessage = async (msg) => { ... return replyText; };
 *   await gw.connect();
 *   // ...
 *   await gw.disconnect();
 */
export class FeishuGateway {
  private appId: string;
  private appSecret: string;
  private domain: string;
  private tenantToken: string = '';
  private tokenExpiresAt: number = 0;
  private wsClient: any = null;
  private _onReady: (() => void) | null = null;
  private _onDisconnect: ((error?: Error) => void) | null = null;

  /** 消息去重：记录已处理的消息 ID（LRU 缓存，最多保留 500 条） */
  private processedMessages: Set<string> = new Set();
  private readonly maxProcessedMessages = 500;

  /** 获取去重文件的绝对路径 */
  private getProcessedMessagesFilePath(): string {
    const homeDir = os.homedir();
    const geminiDir = path.join(homeDir, '.deepv');
    return path.join(geminiDir, 'feishu-processed-messages.json');
  }

  /** 从文件加载已处理的消息 ID */
  private loadProcessedMessages(): void {
    try {
      const filePath = this.getProcessedMessagesFilePath();
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const ids = JSON.parse(content);
        if (Array.isArray(ids)) {
          this.processedMessages = new Set(ids.filter(id => typeof id === 'string' && id.startsWith('om_')));
          dlog(`[Feishu] Loaded ${this.processedMessages.size} processed message IDs from persistent cache.`);
          return;
        }
      }
    } catch (e: any) {
      dwarn(`[Feishu] Failed to load processed messages: ${e?.message || e}`);
    }
    this.processedMessages = new Set();
  }

  /** 保存已处理的消息 ID 到文件 */
  private saveProcessedMessages(): void {
    try {
      const filePath = this.getProcessedMessagesFilePath();
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      const ids = Array.from(this.processedMessages);
      fs.writeFileSync(filePath, JSON.stringify(ids, null, 2), 'utf8');
      dlog(`[Feishu] Saved ${ids.length} processed message IDs to persistent cache.`);
    } catch (e: any) {
      dwarn(`[Feishu] Failed to save processed messages: ${e?.message || e}`);
    }
  }

  /** 内容去重：key 为 "chatId:text"，value 为首次处理时间戳（5 秒窗口内相同内容视为重复） */
  private recentContents: Map<string, number> = new Map();
  private readonly dedupWindowMs = 5000;

  /** 外部注入的消息处理回调 */
  onMessage: OnMessageCallback | null = null;

  /** 外部注入的卡片按钮点击回调 */
  onCardAction: OnCardActionCallback | null = null;

  /**
   * 等待卡片按钮点击的 Promise 映射
   * key = 卡片 message_id, value = { resolve, timer }
   */
  private cardCallbacks = new Map<string, {
    resolve: (data: CardActionData) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * 文本选择模式的临时回调
   * 返回 true 表示已消费该消息，不让它进入主消息处理流程
   */
  private textChoiceCallback: ((msg: FeishuMessage) => boolean) | null = null;

  /**
   * 最近一次 waitForCardAction 发送的卡片 message_id
   * 用于调用方在获取用户选择后更新卡片内容
   */
  private lastCardMessageId: string | null = null;

  /** 获取最近一次卡片的 message_id */
  getLastCardMessageId(): string | null {
    return this.lastCardMessageId;
  }

  /** 连接状态回调 */
  get onReady(): (() => void) | null { return this._onReady; }
  set onReady(fn: (() => void) | null) { this._onReady = fn; }

  get onDisconnect(): ((error?: Error) => void) | null { return this._onDisconnect; }
  set onDisconnect(fn: ((error?: Error) => void) | null) { this._onDisconnect = fn; }

  getAppId(): string { return this.appId; }
  getAppSecret(): string { return this.appSecret; }
  getDomain(): string { return this.domain; }

  constructor(appId: string, appSecret: string, domain: 'feishu' | 'lark' = 'feishu') {
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
    this.loadProcessedMessages();
  }

  private get apiBaseUrl(): string {
    return API_BASE_URLS[this.domain] || API_BASE_URLS.feishu;
  }

  /**
   * 获取 tenant_access_token（自动缓存+刷新）
   */
  async getTenantToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.tenantToken;
    }

    const res = await fetch(`${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const data: any = await res.json();

    if (!data.tenant_access_token) {
      throw new Error(`Failed to fetch tenant_access_token: ${JSON.stringify(data)}`);
    }

    this.tenantToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (data.expire || 7200) * 1000;
    return this.tenantToken;
  }

  /**
   * 下载飞书 IM 消息中的图片资源并保存为本地临时文件
   */
  async downloadImageResource(messageId: string, imageKey: string): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      if (!token) return null;

      const res = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;

      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const tempDir = os.tmpdir();
      // 🎯 按真实类型落盘（字节头优先，Content-Type 兜底），避免一律 .png
      // 导致下游 mime.lookup 推断出错误的 media_type，触发供应商 400 报错。
      const ext = detectImageExtension(bytes, res.headers.get('content-type'));
      const localPath = path.join(tempDir, `feishu-image-${imageKey}${ext}`);
      fs.writeFileSync(localPath, Buffer.from(buffer));
      return localPath;
    } catch (e: any) {
      dlog(`[Feishu] downloadImageResource failed: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * 下载飞书 IM 消息中的图片资源到指定目录。
   *
   * @param messageId 飞书消息 ID
   * @param imageKey  飞书图片资源 key
   * @param targetDir 目标目录（会自动创建）
   * @returns 本地绝对路径，失败返回 null
   */
  async downloadImageToDir(messageId: string, imageKey: string, targetDir: string): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      if (!token) return null;

      const res = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;

      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.mkdirSync(targetDir, { recursive: true });
      // 🎯 按真实类型落盘（字节头优先，Content-Type 兜底），避免一律 .png
      // 导致下游 mime.lookup 推断出错误的 media_type，触发供应商 400 报错。
      const ext = detectImageExtension(bytes, res.headers.get('content-type'));
      const localPath = path.join(targetDir, `feishu-image-${imageKey}${ext}`);
      fs.writeFileSync(localPath, Buffer.from(buffer));
      return localPath;
    } catch (e: any) {
      dlog(`[Feishu] downloadImageToDir failed: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * 连接飞书 WS 事件订阅（通过 SDK WSClient）
   *
   * SDK 自动：
   *   - pullConnectConfig (POST /callback/ws/endpoint)
   *   - 建立 WebSocket（Protobuf 帧）
   *   - ping/pong 保活
   *   - 自动重连
   */
  async connect(): Promise<void> {
    // 先清理旧连接，避免事件处理器重复触发
    await this.disconnect();

    const { WSClient, EventDispatcher } = await import('@larksuiteoapi/node-sdk');

    const domainUrl = this.domain === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    // 事件分发器：只处理 im.message.receive_v1
    const dispatcher = new EventDispatcher({
      encryptKey: '',
      verificationToken: '',
      loggerLevel: 3,
    });

    dispatcher.register({
      'im.message.receive_v1': async (data: any) => {
      try {
        const event = data.event || data;
        const message = event.message || {};
        const sender = event.sender || {};

        // 解析文本内容，确保始终返回字符串
        let text = '';
        const msgType = message.message_type || 'text';
        // 收集待下载的图片元数据（延迟到 feishuCommand 确定 projectRoot 后统一下载）
        const pendingImages: Array<{ imageKey: string; placeholder: string }> = [];

        if (msgType === 'text') {
          try {
            const content = JSON.parse(message.content || '{}');
            text = typeof content.text === 'string' ? content.text : String(content.text || '');
          } catch {
            text = typeof message.content === 'string' ? message.content : String(message.content || '');
          }
        } else if (msgType === 'image') {
          try {
            const content = JSON.parse(message.content || '{}');
            const imageKey = content.image_key;
            if (imageKey) {
              text = '[图片消息]';
              pendingImages.push({ imageKey, placeholder: '[图片消息]' });
            } else {
              text = '[图片消息]';
            }
          } catch {
            text = '[图片消息]';
          }
        } else if (msgType === 'post') {
          try {
            const content = JSON.parse(message.content || '{}');
            let postContent: any[][] = [];
            let title = '';

            const locales = Object.keys(content);
            const firstLocale = locales[0];
            if (firstLocale && content[firstLocale] && Array.isArray(content[firstLocale].content)) {
              postContent = content[firstLocale].content;
              title = content[firstLocale].title || '';
            } else if (Array.isArray(content.content)) {
              postContent = content.content;
              title = content.title || '';
            } else if (Array.isArray(content)) {
              postContent = content;
            }

            let parts: string[] = [];
            if (title) {
              parts.push(`**${title}**`);
            }

            for (const paragraph of postContent) {
              if (!Array.isArray(paragraph)) continue;
              let paragraphText = '';
              for (const element of paragraph) {
                if (!element || typeof element !== 'object') continue;

                if (element.tag === 'text') {
                  paragraphText += element.text || '';
                } else if (element.tag === 'a') {
                  paragraphText += `[${element.text || ''}](${element.href || ''})`;
                } else if (element.tag === 'at') {
                  paragraphText += element.text || '';
                } else if (element.tag === 'img') {
                  const imageKey = element.image_key;
                  if (imageKey) {
                    const placeholder = `[图片_${pendingImages.length + 1}]`;
                    pendingImages.push({ imageKey, placeholder });
                    paragraphText += placeholder;
                  }
                }
              }
              if (paragraphText.trim()) {
                parts.push(paragraphText);
              }
            }
            text = parts.join('\n');
          } catch (e: any) {
            derror('Parse feishu post message failed:', e);
            text = `[解析富文本消息失败]`;
          }
        } else {
          text = `[不支持的消息类型: ${msgType}]`;
        }

        // 去掉 @bot 占位符
        if (event.mentions) {
          for (const m of event.mentions) {
            if (m.key) {
              text = text.replace(m.key, '').trim();
            }
          }
        }

        const chatType = message.chat_type === 'p2p' ? 'p2p' :
                         message.chat_type === 'group' ? 'group' : 'topic';

        const feishuMsg: FeishuMessage = {
          text,
          messageId: message.message_id,
          chatId: message.chat_id || event.conversation?.chat_id || '',
          chatType,
          senderOpenId: sender.sender_id?.open_id || sender.open_id || '',
          mentions: (event.mentions || []).map((m: any) => ({
            key: m.key,
            openId: m.open_id || '',
          })),
          messageType: message.message_type || 'text',
          pendingImages: pendingImages.length > 0 ? pendingImages : undefined,
        };

        // 消息去重：先按 messageId，再按内容+时间窗口兜底
        if (feishuMsg.messageId && feishuMsg.messageId.startsWith('om_')) {
          if (this.processedMessages.has(feishuMsg.messageId)) {
            dlog(`Skipped duplicate message (messageId): ${feishuMsg.messageId}`);
            return { code: 0 };
          }
        }

        const contentKey = `${feishuMsg.chatId}:${feishuMsg.text}`;
        const now = Date.now();
        const firstSeen = this.recentContents.get(contentKey);
        if (firstSeen !== undefined && now - firstSeen < this.dedupWindowMs) {
          dlog(`Skipped duplicate message (content dedup): "${feishuMsg.text.slice(0, 30)}" (within ${now - firstSeen}ms)`);
          return { code: 0 };
        }

        // 记录已处理的消息
        if (feishuMsg.messageId && feishuMsg.messageId.startsWith('om_')) {
          this.processedMessages.add(feishuMsg.messageId);
          if (this.processedMessages.size > this.maxProcessedMessages) {
            const iterator = this.processedMessages.values();
            const oldest = iterator.next().value;
            if (oldest) this.processedMessages.delete(oldest);
          }
          this.saveProcessedMessages(); // ✨ 持久化到磁盘
        }
        this.recentContents.set(contentKey, now);
        // 清理过期的内容去重记录
        for (const [key, ts] of this.recentContents) {
          if (now - ts > this.dedupWindowMs * 2) this.recentContents.delete(key);
        }

        // 文本选择模式：如果正在等待用户文本回复选项，优先处理
        if (this.textChoiceCallback) {
          const consumed = this.textChoiceCallback(feishuMsg);
          if (consumed) {
            // 该消息已被文本选择器消费，不触发 onMessage
            return { code: 0 };
          }
        }

        if (this.onMessage) {
          // 添加"思考中"表情，让用户知道 Bot 正在处理
          const reactionId = await this.addReaction(feishuMsg.messageId, 'THINKING');
          try {
            const reply = await this.onMessage(feishuMsg);
            if (reply) {
              await this.sendMessage(feishuMsg.chatId, reply, feishuMsg.messageId);
            }
          } catch (err) {
            derror('feishu onMessage handler error:', err);
          } finally {
            // 处理完成，移除"思考中"表情
            await this.removeReaction(feishuMsg.messageId, reactionId);
          }
        }

        return { code: 0 };
      } catch (err) {
        derror('feishu event handler error:', err);
        return { code: 0 };
      }
      }
    });

    // 注册卡片按钮点击回调事件
    dispatcher.register({
      'card.action.trigger': async (data: any) => {
        try {
          dlog('Received card.action.trigger event, full payload:', JSON.stringify(data, null, 2));
          dlog('Current pending cardCallbacks keys:', [...this.cardCallbacks.keys()]);

          const action = data?.event?.action || data?.action || data;
          const openId = data?.event?.operator?.open_id
            || data?.event?.sender?.sender_id?.open_id
            || data?.operator?.open_id
            || '';
          const messageId = data?.event?.context?.open_message_id
            || data?.event?.message_id
            || data?.context?.open_message_id
            || data?.message_id
            || '';
          const rawValue = action?.value ?? action?.option ?? '';
          // action.value 是对象 { choice: "xxx" }，需要提取实际值
          const choiceValue = typeof rawValue === 'object' && rawValue !== null && 'choice' in rawValue
            ? (rawValue as any).choice
            : rawValue;
          const strValue = String(choiceValue ?? '');

          // 🎯 表单提交（form_action.type='submit'）：飞书把所有具名组件的值放在
          // action.form_value 里，键为组件 name，值为下拉选中的 value（或复选组件选中值数组）或输入框文本。
          let formValue: Record<string, string | string[]> | undefined;
          const rawFormValue = action?.form_value;
          if (rawFormValue && typeof rawFormValue === 'object') {
            formValue = {};
            for (const [k, v] of Object.entries(rawFormValue)) {
              if (Array.isArray(v)) {
                formValue[k] = v.map(item => String(item ?? ''));
              } else {
                formValue[k] = String(v ?? '');
              }
            }
          }

          dlog(`Parsed: openId=${openId}, messageId=${messageId}, strValue=${strValue}, formValue=${JSON.stringify(formValue)}`);

          const actionData: CardActionData = { value: strValue, openId, messageId, formValue };

          if (messageId && this.onCardAction) {
            this.onCardAction(actionData);
          }

          // 查找是否有等待中的 Promise
          const pending = this.cardCallbacks.get(messageId);
          if (pending) {
            dlog(`Matched pending callback, resolving with: ${strValue}`);
            clearTimeout(pending.timer);
            this.cardCallbacks.delete(messageId);
            pending.resolve(actionData);
          } else {
            dlog(`No matching pending callback for messageId=${messageId}`);
          }
        } catch (err) {
          derror('Feishu card callback handler error:', err);
        }
        return { code: 0 };
      },
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const client = new WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain: domainUrl,
        loggerLevel: 3, // error only
        onReady: () => {
          dlog('Feishu Bot ready');
          this._onReady?.();
          if (!settled) { settled = true; resolve(); }
        },
        onError: (err: Error) => {
          derror('Feishu WSClient error:', err.message);
          this._onDisconnect?.(err);
          if (!settled) { settled = true; reject(err); }
        },
        onReconnecting: () => {
          dlog('Feishu reconnecting...');
        },
        onReconnected: () => {
          dlog('Feishu reconnected');
        },
      });

      this.wsClient = client;

      // start() 返回 Promise<void>，成功时 resolve
      client.start({ eventDispatcher: dispatcher }).catch((err: any) => {
        if (!settled) { settled = true; reject(err); }
      });
    });
  }

  /**
   * 发送消息到飞书聊天，返回 message_id（用于后续 updateMessage）
   */
  async sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<string | null> {
    const token = await this.getTenantToken();

    const body: any = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    };

    let url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    if (replyToMessageId) {
      url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      delete body.receive_id;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.code === 0) {
      return data.data?.message_id || null;
    }

    // fallback: 10003 错误时尝试直接发送（不 reply）
    if (data.code === 10003 && replyToMessageId) {
      const directUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
      const directRes = await fetch(directUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      });
      const directData: any = await directRes.json();
      if (directData.code === 0) {
        return directData.data?.message_id || null;
      }
      derror('Feishu sendMessage failed:', JSON.stringify(directData));
    } else {
      derror('Feishu sendMessage failed:', JSON.stringify(data));
    }
    return null;
  }

  /**
   * 更新已发送消息的内容（用于流式进度更新）
   *
   * 注意事项:
   *   - 只能更新 bot 自己发送的消息
   *   - 更新时需要传入完整的 content JSON
   *   - 飞书 API 有频率限制，建议调用方做 3 秒节流
   *   - 更新后消息的 msg_type 不可变（初始是 text 就一直是 text）
   *
   * @returns true=更新成功, false=更新失败
   */
  async updateMessage(messageId: string, newText: string): Promise<boolean> {
    if (!messageId) return false;
    try {
      const token = await this.getTenantToken();
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: JSON.stringify({ text: newText }),
          }),
        },
      );
      const data: any = await res.json();
      if (data.code !== 0) {
        dwarn(`Failed to update Feishu message: ${JSON.stringify(data)}`);
        return false;
      }
      return true;
    } catch (err) {
      dwarn('Failed to update Feishu message:', err);
      return false;
    }
  }

  /**
   * 更新已发送消息为 Markdown 富文本（post 格式）
   *
   * 注意：msg_type 不可变，初始消息必须是 post 类型才能用此方法更新为 post 格式。
   * 如果初始消息是 text 类型，此方法会失败。
   *
   * @returns true=更新成功, false=更新失败
   */
  async updateMessageMarkdown(messageId: string, markdown: string): Promise<boolean> {
    if (!messageId) return false;
    try {
      const token = await this.getTenantToken();
      const postContent = {
        zh_cn: {
          title: '',
          content: this.mdToPostContent(markdown),
        },
      };
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: JSON.stringify(postContent),
          }),
        },
      );
      const data: any = await res.json();
      if (data.code !== 0) {
        dwarn(`Failed to update Feishu Markdown message: ${JSON.stringify(data)}`);
        return false;
      }
      return true;
    } catch (err) {
      dwarn('Failed to update Feishu Markdown message:', err);
      return false;
    }
  }

  /**
   * 发送 markdown 消息（post 格式，支持富文本），返回 message_id
   */
  async sendMarkdown(chatId: string, markdown: string, replyToMessageId?: string): Promise<string | null> {
    const token = await this.getTenantToken();

    const postContent = {
      zh_cn: {
        title: '',
        content: this.mdToPostContent(markdown),
      },
    };

    const body: any = {
      receive_id: chatId,
      msg_type: 'post',
      content: JSON.stringify(postContent),
    };

    let url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    if (replyToMessageId) {
      url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      delete body.receive_id;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.code !== 0) {
      derror('Feishu sendMarkdown failed:', JSON.stringify(data));
      return null;
    }
    return data.data?.message_id || null;
  }

  /**
   * 增强版 Markdown → 飞书 post 格式转换
   *
   * 支持：标题、加粗、行内代码、代码块、链接、无序/有序列表、表格
   */
  private mdToPostContent(md: string): any[][] {
    const lines = md.split('\n');
    const paragraphs: any[][] = [];
    let currentPara: any[] = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];

    const flushPara = () => {
      if (currentPara.length > 0) {
        paragraphs.push(currentPara);
        currentPara = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // --- 代码块处理 ---
      if (line.trimStart().startsWith('```')) {
        if (inCodeBlock) {
          // 代码块结束
          flushPara();
          const codeText = codeBlockContent.join('\n');
          const formatted = codeText.split('\n')
            .map(l => '  ' + l)
            .join('\n');
          paragraphs.push([
            { tag: 'text', text: formatted },
          ]);
          codeBlockContent = [];
          inCodeBlock = false;
        } else {
          // 代码块开始
          flushPara();
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent.push(line);
        continue;
      }

      // --- 空行 = 段落分隔 ---
      if (line.trim() === '') {
        flushPara();
        continue;
      }

      // --- 标题 ---
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        flushPara();
        paragraphs.push([
          { tag: 'text', text: headingMatch[2], style: ['bold'] },
        ]);
        continue;
      }

      // --- 无序列表（- / * / +） ---
      const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
      if (ulMatch) {
        const indent = ulMatch[1].length;
        const bullet = '  '.repeat(Math.floor(indent / 2)) + '• ';
        flushPara();
        paragraphs.push([
          { tag: 'text', text: bullet },
          ...this.parseInlineMarkdown(ulMatch[2]),
        ]);
        continue;
      }

      // --- 有序列表（1. 2. 3.） ---
      const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
      if (olMatch) {
        const indent = olMatch[1].length;
        const num = olMatch[2] + '. ';
        const prefix = '  '.repeat(Math.floor(indent / 2)) + num;
        flushPara();
        paragraphs.push([
          { tag: 'text', text: prefix },
          ...this.parseInlineMarkdown(olMatch[3]),
        ]);
        continue;
      }

      // --- 表格行（| ... |） ---
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        // 跳过表格分隔行（|---|---|）
        if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue;
        flushPara();
        const cells = line.trim().split('|').filter(c => c.trim() !== '');
        const tableText = cells.map(c => c.trim()).join(' | ');
        paragraphs.push([
          { tag: 'text', text: tableText },
        ]);
        continue;
      }

      // --- 普通文本（含行内 Markdown） ---
      currentPara.push(...this.parseInlineMarkdown(line));
    }

    // 处理未关闭的代码块
    if (inCodeBlock && codeBlockContent.length > 0) {
      paragraphs.push([{ tag: 'text', text: codeBlockContent.join('\n') }]);
    }

    flushPara();

    if (paragraphs.length === 0) {
      paragraphs.push([{ tag: 'text', text: md }]);
    }

    return paragraphs;
  }

  /**
   * 解析行内 Markdown：加粗、行内代码、链接
   * 返回飞书 post 元素数组
   */
  private parseInlineMarkdown(text: string): any[] {
    const elements: any[] = [];
    // 匹配顺序：行内代码 > 链接 > 加粗
    const regex = /(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*(.+?)\*\*)/g;

    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      // match 之前的普通文本
      if (match.index > lastIndex) {
        const plain = text.slice(lastIndex, match.index);
        if (plain) elements.push({ tag: 'text', text: plain });
      }

      if (match[1]) {
        // 行内代码 `code`
        elements.push({ tag: 'text', text: match[2], style: ['inlineCode'] });
      } else if (match[3]) {
        // 链接 [text](url)
        elements.push({ tag: 'a', text: match[4], href: match[5] });
      } else if (match[6]) {
        // 加粗 **text**
        elements.push({ tag: 'text', text: match[7], style: ['bold'] });
      }

      lastIndex = match.index + match[0].length;
    }

    // 剩余普通文本
    if (lastIndex < text.length) {
      elements.push({ tag: 'text', text: text.slice(lastIndex) });
    }

    return elements.length > 0 ? elements : [{ tag: 'text', text }];
  }

  /**
   * 给消息添加 emoji 反应
   * @returns reaction_id（用于后续删除），失败返回空字符串
   */
  async addReaction(messageId: string, emojiType: string): Promise<string> {
    try {
      const token = await this.getTenantToken();
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}/reactions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
        },
      );
      const data: any = await res.json();
      if (data.code === 0 && data.data?.reaction_id) {
        return data.data.reaction_id;
      }
      if (data.code !== 0) {
        dwarn(`Failed to add reaction: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      dwarn('Failed to add reaction:', err);
    }
    return '';
  }

  /**
   * 删除消息的 emoji 反应
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!reactionId) return;
    try {
      const token = await this.getTenantToken();
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );
      const data: any = await res.json();
      if (data.code !== 0) {
        dwarn(`Failed to remove reaction: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      dwarn('Failed to remove reaction:', err);
    }
  }

  /**
   * 上传文件到飞书，返回 file_key
   */
  async uploadFile(filePath: string, fileType: string = 'stream'): Promise<string> {
    const token = await this.getTenantToken();
    const fs = await import('fs');
    const path = await import('path');
    const fileName = path.basename(filePath);
    const fileBuffer = await fs.promises.readFile(filePath);

    const formData = new FormData();
    formData.append('file_type', fileType);
    formData.append('file_name', fileName);
    formData.append('file', new Blob([fileBuffer]), fileName);

    const res = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    const data: any = await res.json();
    if (data.code !== 0) throw new Error(`Upload file failed: ${JSON.stringify(data)}`);
    return data.data.file_key;
  }

  /**
   * 发送文件消息，返回 message_id
   */
  async sendFile(chatId: string, fileKey: string, replyToMessageId?: string): Promise<string | null> {
    const token = await this.getTenantToken();

    const body: any = {
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    };

    let url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    if (replyToMessageId) {
      url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      delete body.receive_id;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.code !== 0) {
      derror('Feishu sendFile failed:', JSON.stringify(data));
      return null;
    }
    return data.data?.message_id || null;
  }

  /**
   * 上传图片并获取 image_key
   */
  async uploadImage(imagePath: string): Promise<string> {
    const token = await this.getTenantToken();
    const fs = await import('fs');
    const fileBuffer = await fs.promises.readFile(imagePath);

    const formData = new FormData();
    formData.append('image_type', 'message');
    formData.append('image', new Blob([fileBuffer]), 'image');

    const res = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/images`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    const data: any = await res.json();
    if (data.code !== 0) throw new Error(`Upload image failed: ${JSON.stringify(data)}`);
    return data.data.image_key;
  }

  /**
   * 发送图片消息，返回 message_id
   */
  async sendImage(chatId: string, imageKey: string, replyToMessageId?: string): Promise<string | null> {
    const token = await this.getTenantToken();

    const body: any = {
      receive_id: chatId,
      msg_type: 'image',
      content: JSON.stringify({ image_key: imageKey }),
    };

    let url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    if (replyToMessageId) {
      url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      delete body.receive_id;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.code !== 0) {
      derror('Feishu sendImage failed:', JSON.stringify(data));
      return null;
    }
    return data.data?.message_id || null;
  }

  /**
   * 发送交互式卡片（带按钮），返回 message_id
   *
   * @param chatId 聊天 ID
   * @param title 卡片标题
   * @param content 卡片正文（支持 markdown 子集）
   * @param buttons 按钮列表 [{ label, value }]
   * @param replyToMessageId 回复的消息 ID（可选）
   * @returns message_id 或 null
   */
  async sendCard(
    chatId: string,
    title: string,
    content: string,
    buttons: Array<{ label: string; value: string }>,
    footerMetrics?: FeishuFooterMetrics, // 新增 footerMetrics 参数
    replyToMessageId?: string,
  ): Promise<string | null> {
    const token = await this.getTenantToken();

    // 构建飞书卡片 JSON
    const elements: any[] = [];

    // 正文内容
    if (content) {
      elements.push({
        tag: 'markdown',
        content: optimizeMarkdownStyle(content, 1),
      });
    }

    // 按钮行（最多 4 个）
    if (buttons.length > 0) {
      elements.push({
        tag: 'action',
        actions: buttons.map((btn) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: btn.label },
          type: 'primary',
          value: { choice: btn.value },
        })),
      });
    }

    // 添加页脚
    if (footerMetrics) {
      elements.push(...buildFeishuFooterElements(footerMetrics));
    }

    const cardContent: Record<string, any> = {
      config: { wide_screen_mode: true, streaming: true },
      elements,
    };
    if (title) {
      cardContent.header = {
        template: 'blue',
        title: { tag: 'plain_text', content: title },
      };
    }

    const contentStr = JSON.stringify(cardContent);

    // 先尝试直接发送（不 reply），因为 reply 接口对 interactive 类型可能有限制
    const body: any = {
      receive_id: chatId,
      msg_type: 'interactive',
      content: contentStr,
    };

    const directUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;

    dlog('Feishu sendCard request:', JSON.stringify({
      url: directUrl,
      msg_type: 'interactive',
      cardContent: cardContent,
    }));

    const res = await fetch(directUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.code === 0) {
      dlog('Feishu sendCard ok, message_id:', data.data?.message_id);
      return data.data?.message_id || null;
    }

    // 直接发送失败，尝试 reply 方式
    dwarn(`Feishu sendCard direct failed (code=${data.code}): ${data.msg}`);
    if (replyToMessageId) {
      const replyUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      const replyBody: any = {
        msg_type: 'interactive',
        content: contentStr,
      };
      dlog('Feishu retrying sendCard via reply...');
      const replyRes = await fetch(replyUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(replyBody),
      });
      const replyData: any = await replyRes.json();
      if (replyData.code === 0) {
        dlog('Feishu sendCard reply ok, message_id:', replyData.data?.message_id);
        return replyData.data?.message_id || null;
      }
      derror('Feishu sendCard reply also failed:', JSON.stringify(replyData));
    } else {
      derror('Feishu sendCard failed:', JSON.stringify(data));
    }
    return null;
  }

  /**
   * 飞书建群并拉人
   * @param name 群名称
   * @param userOpenId 要拉入群的用户 open_id
   * @returns 新创建的群聊的 chat_id, 失败返回 null
   */
  async createGroupChat(name: string, userOpenId: string): Promise<string | null> {
    try {
      const token = await this.getTenantToken();

      const body = {
        name,
        description: 'DeepV Code 自动创建的项目专属协作群',
        user_id_list: [userOpenId],
      };

      const res = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/chats?uuid=${Date.now()}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data: any = await res.json();
      if (data.code === 0) {
        dlog(`Successfully created group chat '${name}', chat_id: ${data.data?.chat_id}`);
        return data.data?.chat_id || null;
      }
      dwarn(`Failed to create group chat: ${JSON.stringify(data)}`);
      return null;
    } catch (err) {
      derror('Error creating group chat:', err);
      return null;
    }
  }

  /**
   * 更新已发送的交互式卡片内容（PATCH）
   *
   * 卡片 msg_type 为 interactive，PATCH 时也必须传 interactive 格式的 content。
   * 常用于用户点击按钮后将卡片更新为"已选择: XXX"状态，移除按钮。
   *
   * @param messageId 要更新的卡片消息 ID
   * @param title 新卡片标题
   * @param content 新卡片正文（markdown）
   * @returns true=更新成功, false=更新失败
   */
  async updateCard(
    messageId: string,
    title: string,
    content: string,
    footerMetrics?: FeishuFooterMetrics, // 新增 footerMetrics 参数
  ): Promise<boolean> {
    if (!messageId) return false;
    try {
      const token = await this.getTenantToken();

      const elements: any[] = [];
      if (content) {
        elements.push({ tag: 'markdown', content: optimizeMarkdownStyle(content, 1) });
      }

      // 添加页脚
      if (footerMetrics) {
        elements.push(...buildFeishuFooterElements(footerMetrics));
      }

      const cardContent = {
        config: { wide_screen_mode: true, streaming: true },
        header: title
          ? {
              template: 'green',
              title: { tag: 'plain_text', content: title },
            }
          : undefined,
        elements,
      };

      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: JSON.stringify(cardContent),
          }),
        },
      );
      const data: any = await res.json();
      if (data.code !== 0) {
        dwarn(`Failed to update Feishu card: ${JSON.stringify(data)}`);
        return false;
      }
      return true;
    } catch (err) {
      dwarn('Failed to update Feishu card:', err);
      return false;
    }
  }

  /**
   * 发送一个 CardKit 2.0 流式卡片，并返回流式更新接口。
   *
   * 工作流程（参考 openclaw-lark 的 streaming-card-controller）：
   *   1. cardkit.v1.card.create  →  card_id
   *   2. im.message.create/reply (msg_type=interactive, content={type:'card',data:{card_id}})  →  message_id
   *   3. （流式中多次）cardkit.v1.cardElement.content  →  增量推送到 element_id 上，飞书自带打字机动画
   *   4. （结束时）cardkit.v1.card.settings(streaming_mode:false) + cardkit.v1.card.update(终态整卡)
   *
   * 节流策略：CardKit 流式更新接口节流极低（~100ms），调用方按需节流即可。
   *
   * @param chatId            目标 chat_id
   * @param initialContent    流式起始内容（可空）
   * @param initialFooter     初始页脚 metrics（可选，渲染为 footer markdown）
   * @param replyToMessageId  回复的源消息 message_id（可选）
   * @returns                 一个会话句柄；若 CardKit 创建失败，messageId 为 null
   */
  async sendStreamingCardWithFooter(
    chatId: string,
    initialContent: string,
    initialFooterMetrics?: FeishuFooterMetrics,
    replyToMessageId?: string,
  ): Promise<{
    messageId: string | null;
    cardId: string | null;
    /**
     * 增量推送正文到 streaming_content element。content 是当前累计的完整文本（不是 delta）。
     * 飞书自动 diff 渲染打字机效果。
     */
    pushContent: (content: string) => Promise<boolean>;
    /**
     * 增量更新 footer 元素（独立于正文，使用同一 sequence 计数器）。
     */
    pushFooter: (metrics: FeishuFooterMetrics) => Promise<boolean>;
    /**
     * 结束流式：关闭 streaming_mode 并整卡覆盖一次（终态文本 + footer）。
     */
    finalize: (finalContent: string, finalFooterMetrics?: FeishuFooterMetrics) => Promise<boolean>;
  }> {
    const noopHandle = {
      messageId: null,
      cardId: null,
      pushContent: async () => false,
      pushFooter: async () => false,
      finalize: async () => false,
    };

    // Step 1: cardkit.v1.card.create — 拿到 card_id
    const initialFooterText = initialFooterMetrics ? renderFooterMarkdown(initialFooterMetrics) : '';
    const initialCard = buildCardKitStreamingCard(initialContent, initialFooterText);
    const cardId = await this.createCardKitCard(initialCard);
    if (!cardId) {
      // CardKit 创建失败 — 调用方走 sendCard 兜底
      return noopHandle;
    }

    // Step 2: im.message.create/reply 引用 card_id 把卡片送进群
    const messageId = await this.sendCardKitMessage(chatId, cardId, replyToMessageId);
    if (!messageId) {
      return { ...noopHandle, cardId };
    }

    // 持有一个递增的 sequence，所有后续 cardkit.v1.* 调用共享
    let sequence = 1;
    let lastPushedContent = initialContent;
    let lastPushedFooter = initialFooterText;

    const pushContent = async (content: string): Promise<boolean> => {
      if (content === lastPushedContent) return true; // 无变化，省一次 RPC
      sequence += 1;
      const ok = await this.streamCardKitElement(cardId, CARDKIT_STREAMING_ELEMENT_ID, optimizeMarkdownStyle(content, 2) || ' ', sequence);
      if (ok) lastPushedContent = content;
      return ok;
    };

    const pushFooter = async (metrics: FeishuFooterMetrics): Promise<boolean> => {
      const next = renderFooterMarkdown(metrics);
      if (!next || next === lastPushedFooter) return true;
      sequence += 1;
      const ok = await this.streamCardKitElement(cardId, CARDKIT_FOOTER_ELEMENT_ID, next, sequence);
      if (ok) lastPushedFooter = next;
      return ok;
    };

    const finalize = async (
      finalContent: string,
      finalFooterMetrics?: FeishuFooterMetrics,
    ): Promise<boolean> => {
      // 关闭流式模式
      sequence += 1;
      await this.setCardKitStreamingMode(cardId, false, sequence);

      // 整卡更新到终态
      sequence += 1;
      const finalCard = buildCardKitFinalCard(finalContent, finalFooterMetrics);
      return await this.updateCardKitCard(cardId, finalCard, sequence);
    };

    return { messageId, cardId, pushContent, pushFooter, finalize };
  }

  // ------------------------------------------------------------------
  // CardKit 2.0 底层 API（直接 fetch /open-apis/cardkit/v1/...）
  // ------------------------------------------------------------------

  /**
   * cardkit.v1.card.create — 在飞书侧创建一张 CardKit 2.0 卡片实体。
   * 注意：此时卡片尚未发送给任何用户，需要再调 im.message.create 引用 card_id 才会显示。
   *
   * @param card 完整卡片 JSON（schema:'2.0'）
   * @returns card_id 或 null
   */
  async createCardKitCard(card: Record<string, any>): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      const res = await fetch(`${this.apiBaseUrl}/open-apis/cardkit/v1/cards`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'card_json',
          data: JSON.stringify(card),
        }),
      });
      const data: any = await res.json();
      if (data.code !== 0) {
        derror(`Feishu cardkit.card.create failed (code=${data.code}): ${data.msg}`);
        return null;
      }
      const cardId = data.data?.card_id || null;
      dlog('Feishu cardkit.card.create ok, card_id:', cardId);
      return cardId;
    } catch (err: any) {
      derror('Feishu cardkit.card.create error:', err?.message || err);
      return null;
    }
  }

  /**
   * 把已创建的 CardKit 卡片以 IM 消息的形式发送到 chat。
   * content 格式必须是 {"type":"card","data":{"card_id":"<id>"}}。
   */
  async sendCardKitMessage(
    chatId: string,
    cardId: string,
    replyToMessageId?: string,
  ): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      const contentStr = JSON.stringify({ type: 'card', data: { card_id: cardId } });

      // 优先 reply（如果提供），否则直接发送
      if (replyToMessageId) {
        const replyUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
        const replyRes = await fetch(replyUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            msg_type: 'interactive',
            content: contentStr,
          }),
        });
        const replyData: any = await replyRes.json();
        if (replyData.code === 0) {
          dlog('Feishu sendCardKitMessage(reply) ok, message_id:', replyData.data?.message_id);
          return replyData.data?.message_id || null;
        }
        dwarn(`Feishu sendCardKitMessage(reply) failed (code=${replyData.code}): ${replyData.msg}`);
        // 落到下面的直接发送
      }

      const directUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
      const res = await fetch(directUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'interactive',
          content: contentStr,
        }),
      });
      const data: any = await res.json();
      if (data.code === 0) {
        dlog('Feishu sendCardKitMessage(direct) ok, message_id:', data.data?.message_id);
        return data.data?.message_id || null;
      }
      derror(`Feishu sendCardKitMessage failed (code=${data.code}): ${data.msg}`);
      return null;
    } catch (err: any) {
      derror('Feishu sendCardKitMessage error:', err?.message || err);
      return null;
    }
  }

  /**
   * cardkit.v1.cardElement.content — 流式增量更新某个 element 的 markdown content。
   *
   * 飞书会自动对比新旧 content，按字符差异渲染打字机动画。
   * content 是 **当前完整累计文本**，不是 delta。
   *
   * @param cardId    cardkit.card.create 返回的 card_id
   * @param elementId 要更新的元素 id（常用 'streaming_content' / 'footer_content'）
   * @param content   新的完整文本
   * @param sequence  单调递增的序号；同一 card_id 上必须严格递增，否则飞书会丢包/乱序
   */
  async streamCardKitElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<boolean> {
    try {
      const token = await this.getTenantToken();
      const url = `${this.apiBaseUrl}/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, sequence }),
      });
      const data: any = await res.json();
      if (data.code === 0) return true;

      // 速率限制（230020）— 静默跳过这一帧，不算错
      if (data.code === 230020) {
        dlog(`Feishu cardkit.cardElement.content rate limited (seq=${sequence}), skip`);
        return false;
      }
      dwarn(
        `Feishu cardkit.cardElement.content failed (code=${data.code}, seq=${sequence}): ${data.msg}`,
      );
      return false;
    } catch (err: any) {
      derror('Feishu cardkit.cardElement.content error:', err?.message || err);
      return false;
    }
  }

  /**
   * cardkit.v1.card.settings — 切换 streaming_mode（开/关）。
   * 流式结束时务必调一次 streamingMode=false，否则飞书会一直保留流式视觉。
   */
  async setCardKitStreamingMode(
    cardId: string,
    streamingMode: boolean,
    sequence: number,
  ): Promise<boolean> {
    try {
      const token = await this.getTenantToken();
      const url = `${this.apiBaseUrl}/open-apis/cardkit/v1/cards/${cardId}/settings`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          settings: JSON.stringify({ streaming_mode: streamingMode }),
          sequence,
        }),
      });
      const data: any = await res.json();
      if (data.code === 0) return true;
      dwarn(
        `Feishu cardkit.card.settings failed (code=${data.code}, seq=${sequence}): ${data.msg}`,
      );
      return false;
    } catch (err: any) {
      derror('Feishu cardkit.card.settings error:', err?.message || err);
      return false;
    }
  }

  /**
   * cardkit.v1.card.update — 整卡覆盖更新（终态用）。
   * 与 streamCardKitElement 不同，这是一次性替换整张卡片的 JSON。
   */
  async updateCardKitCard(
    cardId: string,
    card: Record<string, any>,
    sequence: number,
  ): Promise<boolean> {
    try {
      const token = await this.getTenantToken();
      const url = `${this.apiBaseUrl}/open-apis/cardkit/v1/cards/${cardId}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          card: { type: 'card_json', data: JSON.stringify(card) },
          sequence,
        }),
      });
      const data: any = await res.json();
      if (data.code === 0) return true;
      dwarn(
        `Feishu cardkit.card.update failed (code=${data.code}, seq=${sequence}): ${data.msg}`,
      );
      return false;
    } catch (err: any) {
      derror('Feishu cardkit.card.update error:', err?.message || err);
      return false;
    }
  }

  /**
   * 🎯 用一张「表单卡片」一次性收集多个问题的答案（飞书 schema 2.0 form）。
   *
   * 每个问题渲染为：
   *   - 一个下拉单选框（select_static），选项含各候选项 + 一个「✏️ 其他（填空）」
   *   - 一个单行输入框（input），当用户在下拉里选「其他」时填写自定义答案
   * 卡片底部是一个统一的「提交」按钮（form_action.type='submit'）。
   *
   * 用户点提交后，飞书通过长连接推送 card.action.trigger，action.form_value
   * 一次带回所有具名组件的值。我们按 name（q{idx} / q{idx}_other）解析回每个问题。
   *
   * 飞书 WS 长连接**支持**卡片回调（card.action.trigger 是官方推荐方式），
   * 因此这是主路径。仅当卡片发送失败时，调用方应回退到文本序号模式。
   *
   * @returns 成功返回 { ok: true, answers }；卡片发送失败返回 { ok: false }。
   *          超时则 answers 里对应问题为空字符串，交由调用方判定"未回答"。
   */
  async askQuestionsViaForm(
    chatId: string,
    questions: FeishuQuestion[],
    timeoutMs: number = DEFAULT_CARD_ACTION_TIMEOUT_MS,
    replyToMessageId?: string,
  ): Promise<{ ok: boolean; answers?: FeishuQuestionAnswers }> {
    if (!questions || questions.length === 0) {
      return { ok: true, answers: {} };
    }

    const OTHER_VALUE = '__other__';
    const formName = `aq_form_${Date.now()}`;

    // 构建表单内部元素
    const formElements: any[] = [];
    questions.forEach((q, idx) => {
      const title = q.header ? `${q.header}: ${q.question}` : q.question;

      // 问题标题（markdown，作为下拉框上方的说明）
      formElements.push({
        tag: 'markdown',
        content: `**${idx + 1}. ${title}**`,
      });

      // 下拉选项：候选项 + "其他（填空）"
      const options = (q.options || []).map((opt, oi) => ({
        text: {
          tag: 'plain_text',
          content: opt.description ? `${opt.label} — ${opt.description}` : opt.label,
        },
        value: `opt_${oi}`,
      }));
      options.push({
        text: { tag: 'plain_text', content: '✏️ 其他（在下方填空）' },
        value: OTHER_VALUE,
      });

      if (q.multiSelect) {
        formElements.push({
          tag: 'multi_select_static',
          name: `q${idx}`,
          placeholder: { tag: 'plain_text', content: '请选择选项（可多选）' },
          options,
          width: 'fill',
        });
      } else {
        formElements.push({
          tag: 'select_static',
          name: `q${idx}`,
          placeholder: { tag: 'plain_text', content: '请选择一个选项' },
          options,
          width: 'fill',
        });
      }

      // 自定义填空（选择"其他"时填写；其它情况留空即可）
      formElements.push({
        tag: 'input',
        name: `q${idx}_other`,
        placeholder: { tag: 'plain_text', content: '如选「其他」，请在此填写自定义答案' },
      });
    });

    // 提交按钮
    formElements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '提交' },
      type: 'primary',
      width: 'default',
      name: 'submit_btn',
      action_type: 'form_submit',
    });

    const card: Record<string, any> = {
      schema: '2.0',
      config: { update_multi: true, wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '请回答以下问题' },
      },
      body: {
        elements: [
          {
            tag: 'form',
            name: formName,
            elements: formElements,
          },
        ],
      },
    };

    // 发送卡片
    const messageId = await this.sendRawInteractiveCard(chatId, card, replyToMessageId);
    if (!messageId) {
      dwarn('askQuestionsViaForm: failed to send form card, caller should fallback');
      return { ok: false };
    }
    this.lastCardMessageId = messageId;

    // 等待用户提交（card.action.trigger -> form_value）
    const actionData = await new Promise<CardActionData>((resolve) => {
      const timer = setTimeout(() => {
        this.cardCallbacks.delete(messageId);
        resolve({ value: '', openId: '', messageId });
      }, timeoutMs);
      this.cardCallbacks.set(messageId, { resolve, timer });
    });

    // 解析 form_value → 每个问题的答案
    const formValue = actionData.formValue || {};
    const answers: FeishuQuestionAnswers = {};
    questions.forEach((q, idx) => {
      const selectedRaw = formValue[`q${idx}`];
      const otherRaw = formValue[`q${idx}_other`] || '';
      const otherText = (typeof otherRaw === 'string' ? otherRaw : '').trim();

      let answer = '';
      if (q.multiSelect) {
        const selectedArr = Array.isArray(selectedRaw)
          ? selectedRaw
          : selectedRaw
          ? [selectedRaw]
          : [];

        const subAnswers: string[] = [];
        selectedArr.forEach(sel => {
          if (sel === OTHER_VALUE) {
            if (otherText) {
              subAnswers.push(otherText);
            }
          } else if (sel.startsWith('opt_')) {
            const oi = parseInt(sel.slice(4), 10);
            const label = q.options[oi]?.label;
            if (label) {
              subAnswers.push(label);
            }
          }
        });

        // 兜底：如果没在复选框选任何东西，但在输入框填了字，作为填空答案
        if (subAnswers.length === 0 && otherText) {
          subAnswers.push(otherText);
        }

        answer = subAnswers.join(', ');
      } else {
        const selected = typeof selectedRaw === 'string' ? selectedRaw : (selectedRaw?.[0] ?? '');
        if (selected === OTHER_VALUE) {
          answer = otherText; // 用户选了"其他"，取填空内容
        } else if (selected.startsWith('opt_')) {
          const oi = parseInt(selected.slice(4), 10);
          answer = q.options[oi]?.label ?? '';
        }
        // 兜底：没选下拉但填了空，也采纳填空内容
        if (!answer && otherText) {
          answer = otherText;
        }
      }
      answers[q.question] = answer;
    });

    return { ok: true, answers };
  }

  /**
   * 发送一张原始 interactive 卡片（card JSON 直传），返回 message_id。
   * 与 sendCard 不同，这里直接发送调用方构造好的完整 card 对象（含 schema 2.0）。
   */
  async sendRawInteractiveCard(
    chatId: string,
    card: Record<string, any>,
    replyToMessageId?: string,
  ): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      const contentStr = JSON.stringify(card);

      // 优先直接发送
      const directUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
      const res = await fetch(directUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'interactive',
          content: contentStr,
        }),
      });
      const data: any = await res.json();
      if (data.code === 0) {
        dlog('Feishu sendRawInteractiveCard ok, message_id:', data.data?.message_id);
        return data.data?.message_id || null;
      }

      dwarn(`Feishu sendRawInteractiveCard direct failed (code=${data.code}): ${data.msg}`);
      // reply 兜底
      if (replyToMessageId) {
        const replyUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
        const replyRes = await fetch(replyUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ msg_type: 'interactive', content: contentStr }),
        });
        const replyData: any = await replyRes.json();
        if (replyData.code === 0) {
          dlog('Feishu sendRawInteractiveCard(reply) ok, message_id:', replyData.data?.message_id);
          return replyData.data?.message_id || null;
        }
        derror('Feishu sendRawInteractiveCard reply also failed:', JSON.stringify(replyData));
      }
      return null;
    } catch (err: any) {
      derror('Feishu sendRawInteractiveCard error:', err?.message || err);
      return null;
    }
  }

  /**
   * 发送卡片并等待用户点击按钮
   *
   * 飞书 WS 长连接**支持**卡片回调（card.action.trigger 是官方推荐方式）。
   * 本方法先发交互卡片，再在 cardCallbacks 注册等待点击；超时或卡片发送失败
   * 时回退到文本序号选择模式，保证在任何情况下都能拿到用户输入。
   *
   * @returns 用户选择的按钮 value，超时返回 defaultValue
   */
  async waitForCardAction(
    chatId: string,
    title: string,
    content: string,
    buttons: Array<{ label: string; value: string }>,
    defaultValue: string,
    timeoutMs: number = DEFAULT_CARD_ACTION_TIMEOUT_MS,
    replyToMessageId?: string,
  ): Promise<string> {
    // 1) 先尝试发交互卡片
    const messageId = await this.sendCard(
      chatId,
      title,
      content,
      buttons,
      undefined,
      replyToMessageId,
    );

    // 2) 卡片发送失败 → 回退文本序号模式
    if (!messageId) {
      dwarn('waitForCardAction: sendCard failed, falling back to text-choice mode');
      return this.waitForTextChoice(chatId, title, content, buttons, defaultValue, timeoutMs);
    }
    this.lastCardMessageId = messageId;

    // 3) 注册等待点击
    const actionData = await new Promise<CardActionData>((resolve) => {
      const timer = setTimeout(() => {
        this.cardCallbacks.delete(messageId);
        resolve({ value: defaultValue, openId: '', messageId });
      }, timeoutMs);
      this.cardCallbacks.set(messageId, { resolve, timer });
    });

    return actionData.value || defaultValue;
  }

  /**
   * 文本选择模式：发送选项列表（markdown），等待用户回复匹配
   *
   * 因为飞书 WebSocket 长连接不支持卡片回调（card.action.trigger），
   * 这是唯一可用的交互方式。用户回复序号或选项名称来选择。
   *
   * 匹配逻辑：用户回复的文本与按钮 label 不区分大小写匹配。
   * 如果超时，返回 defaultValue。
   */
  private waitForTextChoice(
    chatId: string,
    title: string,
    content: string,
    buttons: Array<{ label: string; value: string }>,
    defaultValue: string,
    timeoutMs: number,
  ): Promise<string> {
    // 构建 markdown 格式的选项列表
    const lines = [`**${title || '请选择'}**\n`];

    // 🎨 完美对齐：如果 LLM 给出了选项的详细描述/问题解析（content），必须要完整、清晰地展示给用户看，避免信息丢失！
    if (content && content.trim()) {
      lines.push(`${content.trim()}\n`);
    }

    buttons.forEach((btn, i) => {
      lines.push(`> **${i + 1}**. ${btn.label}`);
    });
    lines.push('\n请回复序号或选项名称进行选择。');
    const textContent = lines.join('\n');

    return new Promise<string>(async (resolve) => {
      // 发送选项列表（使用 markdown 格式）
      await this.sendMarkdown(chatId, textContent);

      // 监听下一条来自同一聊天的消息
      const timer = setTimeout(() => {
        this.textChoiceCallback = null;
        resolve(defaultValue);
      }, timeoutMs);

      const buttonMap = new Map<string, string>();
      // label → value 映射（不区分大小写）
      buttons.forEach((btn) => {
        buttonMap.set(btn.label.toLowerCase(), btn.value);
      });
      // 序号 → value 映射
      buttons.forEach((btn, i) => {
        buttonMap.set(String(i + 1), btn.value);
      });

      this.textChoiceCallback = (msg: FeishuMessage) => {
        if (msg.chatId !== chatId) return false;
        const reply = msg.text.trim();
        // 尝试匹配
        const matched = buttonMap.get(reply.toLowerCase());
        if (matched !== undefined) {
          clearTimeout(timer);
          this.textChoiceCallback = null;
          resolve(matched);
          return true; // 已消费该消息
        }
        // 不匹配的回复，不做处理（交给主消息循环）
        return false;
      };
    });
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    // 清理所有等待中的卡片回调（以空数据 resolve，让等待方走"未回答"分支）
    for (const [, pending] of this.cardCallbacks) {
      clearTimeout(pending.timer);
      pending.resolve({ value: '', openId: '', messageId: '' });
    }
    this.cardCallbacks.clear();

    // 清理文本选择回调
    this.textChoiceCallback = null;

    if (this.wsClient) {
      try {
        this.wsClient.stop?.();
      } catch {
        // ignore
      }
      this.wsClient = null;
    }
  }
}
