/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书消息网关 — WebSocket 长连接收发消息
 *
 * 连飞书开放平台的标准 WebSocket 事件订阅端点：
 *   wss://open.feishu.cn/ws/v1/events?app_id=xxx&app_secret=xxx
 *
 * 收消息 → 调 onMessage 回调 → 发回复走 REST API
 */

const WS_BASE_URLS: Record<string, string> = {
  feishu: 'wss://open.feishu.cn',
  lark: 'wss://open.larksuite.com',
};

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
 * 飞书 WS 网关
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
  private ws: import('ws').WebSocket | null = null;
  private tenantToken: string = '';
  private tokenExpiresAt: number = 0;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** 外部注入的消息处理回调 */
  onMessage: OnMessageCallback | null = null;

  /** 连接状态回调 */
  onReady: (() => void) | null = null;
  onDisconnect: ((error?: Error) => void) | null = null;

  constructor(appId: string, appSecret: string, domain: 'feishu' | 'lark' = 'feishu') {
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
  }

  private get wsBaseUrl(): string {
    return WS_BASE_URLS[this.domain] || WS_BASE_URLS.feishu;
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
   * 连接飞书 WS 事件订阅
   */
  async connect(): Promise<void> {
    // 动态 import ws（它是 core 的依赖，cli 通过 workspace 可访问）
    const { default: WebSocket } = await import('ws');

    const token = await this.getTenantToken();
    const wsUrl = `${this.wsBaseUrl}/ws/v1/events?app_id=${this.appId}&app_secret=${this.appSecret}`;

    console.log(`🔌 连接飞书 WebSocket: ${this.wsBaseUrl}/ws/v1/events`);

    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        console.log('✅ 飞书 WebSocket 已连接');
        this.ws = ws;
        this.onReady?.();
        resolve();
      });

      ws.on('message', async (rawData: Buffer) => {
        try {
          const data = JSON.parse(rawData.toString());
          await this.handleWsMessage(data);
        } catch (err) {
          console.error('❌ 飞书消息解析失败:', err);
        }
      });

      ws.on('error', (err: Error) => {
        console.error('❌ 飞书 WebSocket 错误:', err.message);
        if (!this.ws) {
          reject(err);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log(`🔌 飞书 WebSocket 断开 (code=${code}): ${reason?.toString() || '无原因'}`);
        this.ws = null;
        this.onDisconnect?.(undefined);

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * 处理 WS 消息
   */
  private async handleWsMessage(data: any): Promise<void> {
    // 飞书 WS 协议：需要回复 ack
    if (data.type === 'url_verification') {
      // 首次连接挑战
      if (this.ws) {
        this.ws.send(JSON.stringify({ challenge: data.challenge }));
      }
      return;
    }

    // 事件消息
    if (data.type === 'event_callback' || data.type === 'im.message.receive_v1') {
      // 飞书 WS 协议需要返回 ack
      if (this.ws && data.header?.event_id) {
        this.ws.send(JSON.stringify({
          event_id: data.header.event_id,
          type: 'ack',
        }));
      }

      // 只处理消息接收事件
      const eventType = data.header?.event_type || data.type;
      if (eventType !== 'im.message.receive_v1') {
        return;
      }

      const event = data.event || data;
      const message = event.message || {};

      // 忽略自己发的消息
      const sender = event.sender || {};
      // 不需要过滤，飞书 WS 不会把 bot 自己发的推回来

      // 构建标准化消息
      const chatType = message.chat_type === 'p2p' ? 'p2p' :
                       message.chat_type === 'group' ? 'group' : 'topic';

      // 解析文本内容
      let text = '';
      try {
        const content = JSON.parse(message.content || '{}');
        text = content.text || '';
      } catch {
        text = message.content || '';
      }

      // 去掉 @bot 占位符
      if (event.mentions) {
        for (const m of event.mentions) {
          if (m.key) {
            text = text.replace(m.key, '').trim();
          }
        }
      }

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

      if (this.onMessage) {
        try {
          const reply = await this.onMessage(feishuMsg);
          if (reply) {
            await this.sendMessage(feishuMsg.chatId, reply, feishuMsg.messageId);
          }
        } catch (err) {
          console.error('❌ feishu onMessage 处理器错误:', err);
        }
      }
    }
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
      // 如果 chat_id 类型不对，重试用 open_id
      if (data.code === 10003 && replyToMessageId) {
        // 参数错误，可能是 reply 接口用 chat_id 有问题，直接发消息
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

    // 简单转换：将 markdown 转为飞书 post 格式
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

      // 标题
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        if (currentPara.length > 0) {
          paragraphs.push(currentPara);
          currentPara = [];
        }
        paragraphs.push([
          {
            tag: 'text',
            text: headingMatch[2],
            style: ['bold'],
          },
        ]);
        continue;
      }

      // 粗体
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
   * 定时重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log('🔄 5 秒后尝试重连飞书...');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // 重新拿 token
      this.tenantToken = '';
      try {
        await this.connect();
      } catch (err) {
        console.error('❌ 飞书重连失败，5 秒后重试:', err);
        this.scheduleReconnect();
      }
    }, 5000);
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
