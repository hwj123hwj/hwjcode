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

import { dlog, dwarn, derror } from './logger.js';

const API_BASE_URLS: Record<string, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

export interface FeishuMessage {
  text: string;
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group' | 'topic';
  senderOpenId: string;
  mentions: Array<{ key: string; openId: string }>;
  messageType: string;
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
}

export type OnCardActionCallback = (data: CardActionData) => void;

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

  /** 消息去重：记录已处理的消息 ID（LRU 缓存，最多保留 1000 条） */
  private processedMessages: Set<string> = new Set();
  private readonly maxProcessedMessages = 1000;

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
    resolve: (value: string) => void;
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

  constructor(appId: string, appSecret: string, domain: 'feishu' | 'lark' = 'feishu') {
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
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
        try {
          const content = JSON.parse(message.content || '{}');
          // 确保 text 是字符串类型
          text = typeof content.text === 'string' ? content.text : String(content.text || '');
        } catch {
          // JSON 解析失败，直接使用 content（确保转为字符串）
          text = typeof message.content === 'string' ? message.content : String(message.content || '');
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
        };

        // 消息去重：先按 messageId，再按内容+时间窗口兜底
        if (this.processedMessages.has(feishuMsg.messageId)) {
          dlog(`Skipped duplicate message (messageId): ${feishuMsg.messageId}`);
          return { code: 0 };
        }

        const contentKey = `${feishuMsg.chatId}:${feishuMsg.text}`;
        const now = Date.now();
        const firstSeen = this.recentContents.get(contentKey);
        if (firstSeen !== undefined && now - firstSeen < this.dedupWindowMs) {
          dlog(`Skipped duplicate message (content dedup): "${feishuMsg.text.slice(0, 30)}" (within ${now - firstSeen}ms)`);
          return { code: 0 };
        }

        // 记录已处理的消息
        this.processedMessages.add(feishuMsg.messageId);
        this.recentContents.set(contentKey, now);
        if (this.processedMessages.size > this.maxProcessedMessages) {
          const iterator = this.processedMessages.values();
          const oldest = iterator.next().value;
          if (oldest) this.processedMessages.delete(oldest);
        }
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
            || '';
          const rawValue = action?.value ?? action?.option ?? '';
          // action.value 是对象 { choice: "xxx" }，需要提取实际值
          const choiceValue = typeof rawValue === 'object' && rawValue !== null && 'choice' in rawValue
            ? (rawValue as any).choice
            : rawValue;
          const strValue = String(choiceValue ?? '');

          dlog(`Parsed: openId=${openId}, messageId=${messageId}, strValue=${strValue}`);

          if (messageId && this.onCardAction) {
            this.onCardAction({ value: strValue, openId, messageId });
          }

          // 查找是否有等待中的 Promise
          const pending = this.cardCallbacks.get(messageId);
          if (pending) {
            dlog(`Matched pending callback, resolving with: ${strValue}`);
            clearTimeout(pending.timer);
            this.cardCallbacks.delete(messageId);
            pending.resolve(strValue);
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
    replyToMessageId?: string,
  ): Promise<string | null> {
    const token = await this.getTenantToken();

    // 构建飞书卡片 JSON
    const elements: any[] = [];

    // 正文内容
    if (content) {
      elements.push({
        tag: 'markdown',
        content,
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

    const cardContent: Record<string, any> = {
      config: { wide_screen_mode: true },
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
  ): Promise<boolean> {
    if (!messageId) return false;
    try {
      const token = await this.getTenantToken();

      const elements: any[] = [];
      if (content) {
        elements.push({ tag: 'markdown', content });
      }

      const cardContent = {
        config: { wide_screen_mode: true },
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
   * 发送卡片并等待用户点击按钮
   *
   * **重要**：飞书 WebSocket 长连接模式不支持卡片回调（card.action.trigger），
   * 卡片回调需要 HTTP Webhook 地址。因此在 WS 模式下直接使用文本选择模式。
   *
   * 如果后续配置了 HTTP Webhook 卡片回调，可以改为先发卡片再等待回调。
   *
   * @returns 用户选择的按钮 value，超时返回 defaultValue
   */
  async waitForCardAction(
    chatId: string,
    title: string,
    content: string,
    buttons: Array<{ label: string; value: string }>,
    defaultValue: string,
    timeoutMs: number = 60000,
    _replyToMessageId?: string,
  ): Promise<string> {
    // WebSocket 长连接不支持卡片回调，直接使用文本选择模式
    dlog('WS long-connection mode: using text-choice fallback (card callbacks require HTTP webhook)');
    return this.waitForTextChoice(chatId, title, buttons, defaultValue, timeoutMs);
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
    buttons: Array<{ label: string; value: string }>,
    defaultValue: string,
    timeoutMs: number,
  ): Promise<string> {
    // 构建 markdown 格式的选项列表
    const lines = [`**${title || '请选择'}**\n`];
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
    // 清理所有等待中的卡片回调
    for (const [, pending] of this.cardCallbacks) {
      clearTimeout(pending.timer);
      pending.resolve('');
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
