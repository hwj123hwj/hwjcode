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
      throw new Error(`获取 tenant_access_token 失败: ${JSON.stringify(data)}`);
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
          console.log(`⏭️ 跳过重复消息 (messageId): ${feishuMsg.messageId}`);
          return { code: 0 };
        }

        const contentKey = `${feishuMsg.chatId}:${feishuMsg.text}`;
        const now = Date.now();
        const firstSeen = this.recentContents.get(contentKey);
        if (firstSeen !== undefined && now - firstSeen < this.dedupWindowMs) {
          console.log(`⏭️ 跳过重复消息 (内容去重): "${feishuMsg.text.slice(0, 30)}" (${now - firstSeen}ms 内重复)`);
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

        if (this.onMessage) {
          // 添加"思考中"表情，让用户知道 Bot 正在处理
          const reactionId = await this.addReaction(feishuMsg.messageId, 'THINKING');
          try {
            const reply = await this.onMessage(feishuMsg);
            if (reply) {
              await this.sendMessage(feishuMsg.chatId, reply, feishuMsg.messageId);
            }
          } catch (err) {
            console.error('❌ feishu onMessage 处理器错误:', err);
          } finally {
            // 处理完成，移除"思考中"表情
            await this.removeReaction(feishuMsg.messageId, reactionId);
          }
        }

        return { code: 0 };
      } catch (err) {
        console.error('❌ feishu 事件处理错误:', err);
        return { code: 0 };
      }
      }
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const client = new WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain: domainUrl,
        loggerLevel: 3, // error only
        onReady: () => {
          console.log('✅ 飞书 Bot 已就绪，可以开始聊天了！');
          this._onReady?.();
          if (!settled) { settled = true; resolve(); }
        },
        onError: (err: Error) => {
          console.error('❌ 飞书 WSClient 错误:', err.message);
          this._onDisconnect?.(err);
          if (!settled) { settled = true; reject(err); }
        },
        onReconnecting: () => {
          console.log('🔄 飞书正在重连...');
        },
        onReconnected: () => {
          console.log('✅ 飞书重连成功');
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
   * 发送消息到飞书聊天
   */
  async sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
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
    if (data.code !== 0) {
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
        if (directData.code !== 0) {
          console.error('❌ 飞书发消息失败:', JSON.stringify(directData));
        }
      } else {
        console.error('❌ 飞书发消息失败:', JSON.stringify(data));
      }
    }
  }

  /**
   * 发送 markdown 消息（post 格式，支持富文本）
   */
  async sendMarkdown(chatId: string, markdown: string, replyToMessageId?: string): Promise<void> {
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
      console.error('❌ 飞书发送 markdown 失败:', JSON.stringify(data));
    }
  }

  /**
   * 简单 markdown → 飞书 post 格式转换
   */
  private mdToPostContent(md: string): any[][] {
    const lines = md.split('\n');
    const paragraphs: any[][] = [];
    let currentPara: any[] = [];

    for (const line of lines) {
      if (line.trim() === '') {
        if (currentPara.length > 0) {
          paragraphs.push(currentPara);
          currentPara = [];
        }
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        if (currentPara.length > 0) {
          paragraphs.push(currentPara);
          currentPara = [];
        }
        paragraphs.push([
          { tag: 'text', text: headingMatch[2], style: ['bold'] },
        ]);
        continue;
      }

      const boldParts = line.split(/\*\*(.+?)\*\*/g);
      for (let i = 0; i < boldParts.length; i++) {
        if (boldParts[i]) {
          if (i % 2 === 1) {
            currentPara.push({ tag: 'text', text: boldParts[i], style: ['bold'] });
          } else {
            currentPara.push({ tag: 'text', text: boldParts[i] });
          }
        }
      }
    }

    if (currentPara.length > 0) {
      paragraphs.push(currentPara);
    }

    if (paragraphs.length === 0) {
      paragraphs.push([{ tag: 'text', text: md }]);
    }

    return paragraphs;
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
        console.warn(`⚠️ 添加 reaction 失败: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      console.warn('⚠️ 添加 reaction 异常:', err);
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
        console.warn(`⚠️ 删除 reaction 失败: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      console.warn('⚠️ 删除 reaction 异常:', err);
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
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
