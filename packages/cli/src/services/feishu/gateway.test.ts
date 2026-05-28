/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FeishuGateway,
  buildCardKitStreamingCard,
  buildCardKitFinalCard,
  renderFooterMarkdown,
  CARDKIT_STREAMING_ELEMENT_ID,
  CARDKIT_FOOTER_ELEMENT_ID,
  CARDKIT_LOADING_ELEMENT_ID,
} from './gateway.js';

// Mock logger
vi.mock('./logger.js', () => ({
  dlog: vi.fn(),
  dwarn: vi.fn(),
  derror: vi.fn(),
}));

// Mock @larksuiteoapi/node-sdk
const mockRegister = vi.fn();
vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    WSClient: class {
      private options: any;
      constructor(options: any) {
        this.options = options;
      }
      start = vi.fn().mockImplementation(async () => {
        // Trigger onReady callback immediately to let connect() resolve
        if (this.options && typeof this.options.onReady === 'function') {
          this.options.onReady();
        }
      });
    },
    EventDispatcher: class {
      register = mockRegister;
    },
  };
});

describe('FeishuGateway - Message Parsing', () => {
  let gateway: FeishuGateway;
  let messageCallback: any;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    messageCallback = null;

    mockRegister.mockImplementation((handlers: any) => {
      if (handlers['im.message.receive_v1']) {
        messageCallback = handlers['im.message.receive_v1'];
      }
    });
  });

  it('correctly parses plain text message', async () => {
    await gateway.connect();
    expect(messageCallback).toBeTypeOf('function');

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_123',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello world' }),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: any = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    // Trigger callback
    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.text).toBe('hello world');
    expect(receivedMsg.messageType).toBe('text');
  });

  it('correctly parses post message (rich text) with title and paragraphs', async () => {
    await gateway.connect();
    expect(messageCallback).toBeTypeOf('function');

    const postContent = {
      zh_cn: {
        title: 'My Title',
        content: [
          [
            { tag: 'text', text: 'First line text. ' },
            { tag: 'a', text: 'Link Text', href: 'https://example.com' },
          ],
          [
            { tag: 'at', text: '@SomeUser' },
            { tag: 'text', text: ' Second line.' },
          ],
        ],
      },
    };

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_post_123',
          message_type: 'post',
          content: JSON.stringify(postContent),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: any = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    // Trigger callback
    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.text).toContain('**My Title**');
    expect(receivedMsg.text).toContain('First line text.');
    expect(receivedMsg.text).toContain('[Link Text](https://example.com)');
    expect(receivedMsg.text).toContain('@SomeUser Second line.');
    expect(receivedMsg.messageType).toBe('post');
  });

  it('correctly parses post message with embedded images and defers download', async () => {
    await gateway.connect();

    // Mock downloadImageResource — should NOT be called (download now deferred)
    const downloadSpy = vi.spyOn(gateway, 'downloadImageResource')
      .mockResolvedValue('/tmp/mock-local-image.png');

    const postContent = {
      zh_cn: {
        title: '',
        content: [
          [
            { tag: 'text', text: 'Please analyze this ' },
            { tag: 'img', image_key: 'img_v2_123' },
          ],
        ],
      },
    };

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_post_img_123',
          message_type: 'post',
          content: JSON.stringify(postContent),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: any = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    await messageCallback(mockEvent);

    // Image download is DEFERRED — not called in gateway anymore
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.text).toContain('Please analyze this');
    expect(receivedMsg.text).toContain('[图片_1]');
    // pendingImages should carry the image metadata for later download
    expect(receivedMsg.pendingImages).toBeDefined();
    expect(receivedMsg.pendingImages).toHaveLength(1);
    expect(receivedMsg.pendingImages[0].imageKey).toBe('img_v2_123');
    expect(receivedMsg.pendingImages[0].placeholder).toBe('[图片_1]');
  });
});

// ---------------------------------------------------------------------------
// CardKit 2.0 streaming card builders & footer rendering
// ---------------------------------------------------------------------------

describe('CardKit 2.0 builders', () => {
  it('buildCardKitStreamingCard produces schema 2.0 with streaming_mode and required element ids', () => {
    const card = buildCardKitStreamingCard('initial body', 'initial footer');
    expect(card.schema).toBe('2.0');
    expect(card.config.streaming_mode).toBe(true);
    const elements = card.body.elements as Array<Record<string, any>>;
    const ids = elements.map((e) => e.element_id);
    expect(ids).toContain(CARDKIT_STREAMING_ELEMENT_ID);
    expect(ids).toContain(CARDKIT_FOOTER_ELEMENT_ID);
    expect(ids).toContain(CARDKIT_LOADING_ELEMENT_ID);
    const main = elements.find((e) => e.element_id === CARDKIT_STREAMING_ELEMENT_ID);
    expect(main?.tag).toBe('markdown');
    expect(main?.content).toBe('initial body');
    // loading 图标必须有 custom_icon 配置（飞书客户端据此渲染加载动画）
    const loading = elements.find((e) => e.element_id === CARDKIT_LOADING_ELEMENT_ID);
    expect(loading?.icon?.tag).toBe('custom_icon');
    expect(loading?.icon?.img_key).toBeTruthy();
  });

  it('buildCardKitFinalCard does NOT include loading_icon (terminal state)', () => {
    const card = buildCardKitFinalCard('done', { status: '已完成' });
    const elements = card.body.elements as Array<Record<string, any>>;
    const ids = elements.map((e) => e.element_id);
    // 终态卡片不应该带 loading 图标，飞书客户端会自动停止加载动画
    expect(ids).not.toContain(CARDKIT_LOADING_ELEMENT_ID);
  });

  it('buildCardKitStreamingCard uses placeholder content when given empty strings', () => {
    const card = buildCardKitStreamingCard();
    const elements = card.body.elements as Array<Record<string, any>>;
    // 飞书 markdown 元素 content 不能完全为空，必须用占位字符
    for (const el of elements) {
      expect(typeof el.content).toBe('string');
      expect(el.content.length).toBeGreaterThan(0);
    }
  });

  it('buildCardKitFinalCard closes streaming_mode and includes summary', () => {
    const card = buildCardKitFinalCard('## Done\n\nbody', { status: '已完成', elapsedMs: 1234 });
    expect(card.schema).toBe('2.0');
    expect(card.config.streaming_mode).toBe(false);
    expect(card.config.summary?.content).toBeTruthy();
    const elements = card.body.elements as Array<Record<string, any>>;
    expect(elements.find((e) => e.element_id === CARDKIT_STREAMING_ELEMENT_ID)?.content).toContain('Done');
    expect(elements.find((e) => e.element_id === CARDKIT_FOOTER_ELEMENT_ID)?.content).toContain('已完成');
  });

  it('renderFooterMarkdown formats status/elapsed/tokens/context with separators', () => {
    const text = renderFooterMarkdown({
      status: '已完成',
      elapsedMs: 65000,
      model: 'claude-opus-4-7',
      tokens: { input: 12345, output: 6789 },
      contextPercentage: 42.7,
    });
    expect(text).toContain('已完成');
    expect(text).toContain('1m 5s'); // 65s
    expect(text).toContain('claude-opus-4-7');
    expect(text).toContain('↑12,345');
    expect(text).toContain('↓6,789');
    expect(text).toContain('上下文剩余 57%'); // 100 - 42.7 = 57.3 -> 57%
    expect(text).toContain('·'); // separator
  });

  it('renderFooterMarkdown highlights error status in red', () => {
    const text = renderFooterMarkdown({ status: 'Error: timeout' });
    expect(text).toContain("color='red'");
  });

  it('renderFooterMarkdown returns empty string when no metrics provided', () => {
    expect(renderFooterMarkdown({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// CardKit 2.0 streaming flow (mocked fetch)
// ---------------------------------------------------------------------------

describe('FeishuGateway.sendStreamingCardWithFooter (CardKit 2.0)', () => {
  let gateway: FeishuGateway;
  // 简化的 fetch mock 工厂
  const mockFetchOk = (body: any) => ({
    ok: true,
    json: async () => body,
  } as unknown as Response);

  beforeEach(() => {
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    // 跳过真正的 token 申请
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
  });

  it('happy path: create card → send IM message → push content → push footer → finalize', async () => {
    const fetchMock = vi.fn();
    // 1) cardkit.card.create
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { card_id: 'cardkit_001' } }));
    // 2) im.message.create or reply (since replyToMessageId is provided, prefer reply)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_msg_001' } }));
    // 3) push content (streamCardKitElement)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0 }));
    // 4) push footer (streamCardKitElement)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0 }));
    // 5) close streaming_mode (settings)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0 }));
    // 6) card.update (final)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter(
      'oc_chat_001',
      'hello world',
      { status: '思考中' },
      'om_origin_001',
    );

    expect(handle.cardId).toBe('cardkit_001');
    expect(handle.messageId).toBe('om_msg_001');

    // 验证 cardkit.card.create 调用
    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(String(createUrl)).toContain('/open-apis/cardkit/v1/cards');
    expect(createInit?.method).toBe('POST');
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody.type).toBe('card_json');
    const createCard = JSON.parse(createBody.data);
    expect(createCard.schema).toBe('2.0');
    expect(createCard.config.streaming_mode).toBe(true);

    // 验证 im.message reply 调用
    const [imUrl, imInit] = fetchMock.mock.calls[1];
    expect(String(imUrl)).toContain('/open-apis/im/v1/messages/om_origin_001/reply');
    const imBody = JSON.parse(imInit?.body as string);
    expect(imBody.msg_type).toBe('interactive');
    const imContent = JSON.parse(imBody.content);
    expect(imContent.type).toBe('card');
    expect(imContent.data.card_id).toBe('cardkit_001');

    // pushContent
    const pushOk = await handle.pushContent('hello world updated');
    expect(pushOk).toBe(true);
    const [pushUrl, pushInit] = fetchMock.mock.calls[2];
    expect(String(pushUrl)).toContain(`/cardkit/v1/cards/cardkit_001/elements/${CARDKIT_STREAMING_ELEMENT_ID}/content`);
    expect(pushInit?.method).toBe('PUT');
    const pushBody = JSON.parse(pushInit?.body as string);
    expect(pushBody.content).toBe('hello world updated');
    expect(typeof pushBody.sequence).toBe('number');
    expect(pushBody.sequence).toBeGreaterThanOrEqual(2);

    // pushFooter
    const footerOk = await handle.pushFooter({ status: '已完成', elapsedMs: 1500 });
    expect(footerOk).toBe(true);
    const [footerUrl, footerInit] = fetchMock.mock.calls[3];
    expect(String(footerUrl)).toContain(`/elements/${CARDKIT_FOOTER_ELEMENT_ID}/content`);
    const footerBody = JSON.parse(footerInit?.body as string);
    expect(footerBody.content).toContain('已完成');

    // finalize → settings + update
    const finalizeOk = await handle.finalize('final answer', { status: '已完成', elapsedMs: 2000 });
    expect(finalizeOk).toBe(true);

    const [settingsUrl, settingsInit] = fetchMock.mock.calls[4];
    expect(String(settingsUrl)).toContain('/cardkit/v1/cards/cardkit_001/settings');
    expect(settingsInit?.method).toBe('PATCH');
    const settingsBody = JSON.parse(settingsInit?.body as string);
    expect(JSON.parse(settingsBody.settings).streaming_mode).toBe(false);

    const [updateUrl, updateInit] = fetchMock.mock.calls[5];
    expect(String(updateUrl)).toContain('/cardkit/v1/cards/cardkit_001');
    expect(updateInit?.method).toBe('PUT');
    const updateBody = JSON.parse(updateInit?.body as string);
    const finalCard = JSON.parse(updateBody.card.data);
    expect(finalCard.config.streaming_mode).toBe(false);
  });

  it('returns no-op handle when card.create fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchOk({ code: 230099, msg: 'create failed' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter('oc_chat_001', 'hi');
    expect(handle.cardId).toBeNull();
    expect(handle.messageId).toBeNull();
    expect(await handle.pushContent('x')).toBe(false);
    expect(await handle.finalize('done')).toBe(false);
  });

  it('pushContent skips RPC when content is unchanged', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { card_id: 'cardkit_dedup' } }));
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_dedup' } }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter('oc_chat_x', 'same');
    // 推同样的内容不应该再发请求
    const ok = await handle.pushContent('same');
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 只 create + send，没有 stream
  });

  it('pushContent treats rate-limit (230020) as soft fail without throwing', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { card_id: 'cardkit_rl' } }));
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_rl' } }));
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 230020, msg: 'rate limited' }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter('oc_chat_y', 'a');
    const ok = await handle.pushContent('b');
    expect(ok).toBe(false); // 速率限制返回 false 但不抛异常
  });
});
