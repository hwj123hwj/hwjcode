/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Mock loadProcessedMessages and saveProcessedMessages to isolate tests from real disk
vi.spyOn(FeishuGateway.prototype as any, 'loadProcessedMessages').mockImplementation(function(this: any) {
  this.processedMessages = new Set();
});
vi.spyOn(FeishuGateway.prototype as any, 'saveProcessedMessages').mockImplementation(() => {});

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

describe('FeishuGateway - image download saves with real extension', () => {
  let gateway: FeishuGateway;
  let tmpDir: string;

  // 各类图片的字节头样本（足够触发 magic number 探测）
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const mockImageResponse = (bytes: Uint8Array, contentType: string | null) =>
    ({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? contentType : null,
      },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }) as unknown as Response;

  beforeEach(async () => {
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    tmpDir = path.join(os.tmpdir(), `feishu-img-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    const fs = await import('node:fs');
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('downloadImageToDir saves JPEG bytes with .jpg (not .png) via magic number', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockImageResponse(JPEG, 'image/png')));
    const localPath = await gateway.downloadImageToDir('om_1', 'img_key_1', tmpDir);
    expect(localPath).toBeTruthy();
    expect(localPath!.endsWith('.jpg')).toBe(true);
  });

  it('downloadImageToDir saves GIF bytes with .gif', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockImageResponse(GIF, null)));
    const localPath = await gateway.downloadImageToDir('om_2', 'img_key_2', tmpDir);
    expect(localPath!.endsWith('.gif')).toBe(true);
  });

  it('downloadImageToDir keeps .png for real PNG bytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockImageResponse(PNG, 'image/png')));
    const localPath = await gateway.downloadImageToDir('om_3', 'img_key_3', tmpDir);
    expect(localPath!.endsWith('.png')).toBe(true);
  });

  it('downloadImageResource saves JPEG bytes with .jpg in temp dir', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockImageResponse(JPEG, null)));
    const localPath = await gateway.downloadImageResource('om_4', 'img_key_4');
    expect(localPath).toBeTruthy();
    expect(localPath!.endsWith('.jpg')).toBe(true);
    const fs = await import('node:fs');
    try {
      fs.rmSync(localPath!, { force: true });
    } catch {
      /* ignore */
    }
  });
});

// ---------------------------------------------------------------------------
// Card callbacks over WS long-connection: form card + card.action.trigger
// ---------------------------------------------------------------------------

describe('FeishuGateway - askQuestionsViaForm (interactive form card)', () => {
  let gateway: FeishuGateway;
  let cardActionHandler: any;

  const mockFetchOk = (body: any) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');

    cardActionHandler = null;
    mockRegister.mockImplementation((handlers: any) => {
      if (handlers['card.action.trigger']) {
        cardActionHandler = handlers['card.action.trigger'];
      }
    });
  });

  it('connect() registers a card.action.trigger handler (WS supports card callbacks)', async () => {
    await gateway.connect();
    expect(cardActionHandler).toBeTypeOf('function');
  });

  it('builds a schema 2.0 form card with select_static + input + submit button', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_form_1' } }));
    vi.stubGlobal('fetch', fetchMock);

    // 不等待提交，先验证发出的卡片结构。给极短超时让它尽快 resolve。
    const promise = gateway.askQuestionsViaForm(
      'oc_chat_1',
      [
        {
          question: 'Pick a framework',
          header: 'Framework',
          options: [
            { label: 'React', description: 'UI lib' },
            { label: 'Vue' },
          ],
        },
      ],
      50, // 50ms 超时
    );

    // 等卡片真正发出（sendRawInteractiveCard 是异步的）
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // 验证发出的卡片 JSON
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/open-apis/im/v1/messages');
    const body = JSON.parse(init?.body as string);
    expect(body.msg_type).toBe('interactive');
    const card = JSON.parse(body.content);
    expect(card.schema).toBe('2.0');

    const form = card.body.elements[0];
    expect(form.tag).toBe('form');
    const tags = form.elements.map((e: any) => e.tag);
    expect(tags).toContain('select_static');
    expect(tags).toContain('input');
    expect(tags).toContain('button');

    const select = form.elements.find((e: any) => e.tag === 'select_static');
    expect(select.name).toBe('q0');
    // options = 2 候选 + 1 "其他"
    expect(select.options).toHaveLength(3);
    expect(select.options[0].value).toBe('opt_0');
    expect(select.options[2].value).toBe('__other__');

    const submit = form.elements.find((e: any) => e.tag === 'button');
    expect(submit.action_type).toBe('form_submit');
    expect(submit.name).toBe('submit_btn');

    // 让超时触发，避免悬挂
    const result = await promise;
    expect(result.ok).toBe(true);
    // 超时 → 答案为空
    expect(result.answers!['Pick a framework']).toBe('');
  });

  it('resolves selected option label from form_value', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_form_2' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_2',
      [
        {
          question: 'Pick a framework',
          options: [{ label: 'React' }, { label: 'Vue' }],
        },
      ],
      5000,
    );

    // 等卡片发出后，模拟用户提交（选第二项 Vue = opt_1）
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await cardActionHandler({
      event: {
        context: { open_message_id: 'om_form_2' },
        operator: { open_id: 'ou_user_1' },
        action: {
          tag: 'button',
          value: { action: 'submit_answers' },
          form_value: { q0: 'opt_1', q0_other: '' },
        },
      },
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.answers!['Pick a framework']).toBe('Vue');
  });

  it('resolves custom "other" text when user picks the fill-in option', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_form_3' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_3',
      [{ question: 'Your choice?', options: [{ label: 'A' }, { label: 'B' }] }],
      5000,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await cardActionHandler({
      event: {
        context: { open_message_id: 'om_form_3' },
        action: {
          form_value: { q0: '__other__', q0_other: 'My custom answer' },
        },
      },
    });

    const result = await promise;
    expect(result.answers!['Your choice?']).toBe('My custom answer');
  });

  it('builds a card with tag:multi_select_static when multiSelect is true and parses multiple choices', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_form_multi' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_multi',
      [
        {
          question: 'Select multiple technologies',
          options: [{ label: 'Node.js' }, { label: 'Python' }, { label: 'Go' }],
          multiSelect: true,
        },
      ],
      5000,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Verify card generation
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    const card = JSON.parse(body.content);
    const form = card.body.elements[0];
    const multiSelectStatic = form.elements.find((e: any) => e.tag === 'multi_select_static');

    expect(multiSelectStatic).toBeDefined();
    expect(multiSelectStatic.options).toHaveLength(4); // 3 options + 1 "other"

    // Simulate submission with multiple selections: Node.js (opt_0) and Go (opt_2) + custom filling (other)
    await cardActionHandler({
      event: {
        context: { open_message_id: 'om_form_multi' },
        action: {
          form_value: { q0: ['opt_0', 'opt_2', '__other__'], q0_other: 'Rust' },
        },
      },
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.answers!['Select multiple technologies']).toBe('Node.js, Go, Rust');
  });

  it('resolves answers from unwrapped trigger payload (no event wrapper)', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_form_unwrapped' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_unwrapped',
      [
        {
          question: 'Pick a framework',
          options: [{ label: 'React' }, { label: 'Vue' }],
        },
      ],
      5000,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await cardActionHandler({
      schema: '2.0',
      operator: { open_id: 'ou_user_1' },
      action: {
        tag: 'button',
        form_value: { q0: 'opt_1', q0_other: '' },
      },
      host: 'im_message',
      context: {
        open_message_id: 'om_form_unwrapped',
        open_chat_id: 'oc_chat_unwrapped',
      },
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.answers!['Pick a framework']).toBe('Vue');
  });

  it('returns ok:false when card send fails (caller should fallback to text)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 99991663, msg: 'send failed' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await gateway.askQuestionsViaForm(
      'oc_chat_4',
      [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }],
      5000,
    );
    expect(result.ok).toBe(false);
    expect(result.answers).toBeUndefined();
  });
});

describe('FeishuGateway - waitForCardAction (button card with real callback)', () => {
  let gateway: FeishuGateway;
  let cardActionHandler: any;

  const mockFetchOk = (body: any) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
    cardActionHandler = null;
    mockRegister.mockImplementation((handlers: any) => {
      if (handlers['card.action.trigger']) {
        cardActionHandler = handlers['card.action.trigger'];
      }
    });
  });

  it('sends a button card and resolves with the clicked value', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_btn_1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.waitForCardAction(
      'oc_chat_1',
      'Choose',
      'body',
      [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      '__timeout__',
      5000,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // 用户点击 "yes" 按钮，value 是 { choice: 'yes' }
    await cardActionHandler({
      event: {
        context: { open_message_id: 'om_btn_1' },
        action: { tag: 'button', value: { choice: 'yes' } },
      },
    });

    const choice = await promise;
    expect(choice).toBe('yes');
  });

  it('falls back to text-choice mode when card send fails', async () => {
    await gateway.connect();
    // sendCard 失败 → waitForTextChoice → sendMarkdown 成功
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 99991663, msg: 'fail' })) // sendCard direct fail
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_txt_1' } })); // sendMarkdown
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.waitForCardAction(
      'oc_chat_2',
      'Choose',
      'body',
      [{ label: 'Yes', value: 'yes' }],
      '__timeout__',
      50, // 短超时，触发文本模式超时返回默认值
    );

    const choice = await promise;
    expect(choice).toBe('__timeout__');
    // 第二次 fetch 应是 markdown 文本消息（文本兜底）
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall).toBeTruthy();
  });
});

