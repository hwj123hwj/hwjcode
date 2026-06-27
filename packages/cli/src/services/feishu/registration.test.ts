/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * registration.ts 的域名映射测试。
 *
 * 这一层是「feishu 就是 feishu、lark 就是 lark」需求的真正本体：
 * domain 字符串（'feishu' | 'lark'）→ 实际请求的开放平台 URL 的映射。
 *
 * 之所以单独建这个测试：feishuCommand.test.ts 把整个 registration 模块 mock 掉了，
 * 只能验证「命令层把 'lark' 透传下去」，却测不到「'lark' → accounts.larksuite.com」
 * 这一步映射是否正确。本次 bug（选 Lark 却打到 feishu.cn）恰恰发生在这一步，
 * 所以这里用 mock 全局 fetch 的方式，断言每个函数实际命中的 URL 主机名。
 *
 * 关键断言形式：expect(fetchedUrl).toContain('accounts.larksuite.com')。
 * 若有人把 ACCOUNTS_URLS.lark 误写成 feishu.cn，这些测试会立刻变红。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initRegistration,
  beginRegistration,
  pollRegistration,
  probeCredentials,
} from './registration.js';

/** 收集所有 fetch 调用的 URL，便于断言请求落到了哪个域名。 */
let fetchedUrls: string[];

/** 构造一个 Response-like 对象（registration 用到了 .text() 和 .json()）。 */
function makeResponse(body: unknown, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

beforeEach(() => {
  fetchedUrls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// initRegistration — 注册环境探测打到正确的 accounts.* 域名
// ───────────────────────────────────────────────────────────────────────────
describe('initRegistration domain routing', () => {
  function mockInitOk() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(String(url));
        return makeResponse({ supported_auth_methods: ['client_secret'] });
      }),
    );
  }

  it('routes feishu to accounts.feishu.cn', async () => {
    mockInitOk();
    await initRegistration('feishu');
    expect(fetchedUrls[0]).toContain('https://accounts.feishu.cn/oauth/v1/app/registration');
    expect(fetchedUrls[0]).not.toContain('larksuite');
  });

  it('routes lark to accounts.larksuite.com (the core fix)', async () => {
    mockInitOk();
    await initRegistration('lark');
    expect(fetchedUrls[0]).toContain('https://accounts.larksuite.com/oauth/v1/app/registration');
    expect(fetchedUrls[0]).not.toContain('feishu');
  });

  it('falls back to feishu for an unknown domain', async () => {
    mockInitOk();
    await initRegistration('nonsense');
    expect(fetchedUrls[0]).toContain('https://accounts.feishu.cn');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// beginRegistration — device-code begin 打到正确域名；兜底 qrUrl 用对应开放平台
// ───────────────────────────────────────────────────────────────────────────
describe('beginRegistration domain routing', () => {
  it('routes lark begin to accounts.larksuite.com', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(String(url));
        return makeResponse({
          device_code: 'dev_lark',
          verification_uri_complete: 'https://open.larksuite.com/page/launcher?user_code=AAAA',
          user_code: 'AAAA',
          interval: 5,
          expires_in: 600,
        });
      }),
    );
    const res = await beginRegistration('lark');
    expect(fetchedUrls[0]).toContain('https://accounts.larksuite.com');
    expect(res.qrUrl).toContain('open.larksuite.com');
  });

  it('builds the fallback qrUrl on open.larksuite.com when no verification_uri is returned', async () => {
    // 服务端没回 verification_uri_complete → 走兜底分支，必须用 lark 的开放平台域名
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(String(url));
        return makeResponse({
          device_code: 'dev_lark',
          user_code: 'BBBB',
          interval: 5,
          expires_in: 600,
        });
      }),
    );
    const res = await beginRegistration('lark');
    expect(res.qrUrl).toContain('https://open.larksuite.com/page/launcher');
    expect(res.qrUrl).not.toContain('feishu');
  });

  it('builds the fallback qrUrl on open.feishu.cn for feishu (regression guard)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(String(url));
        return makeResponse({
          device_code: 'dev_fs',
          user_code: 'CCCC',
          interval: 5,
          expires_in: 600,
        });
      }),
    );
    const res = await beginRegistration('feishu');
    expect(fetchedUrls[0]).toContain('https://accounts.feishu.cn');
    expect(res.qrUrl).toContain('https://open.feishu.cn/page/launcher');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// pollRegistration — poll 打到正确域名，并在凭证里带回正确的 domain
// ───────────────────────────────────────────────────────────────────────────
describe('pollRegistration domain routing', () => {
  it('polls accounts.larksuite.com and returns domain=lark', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(String(url));
        return makeResponse({
          client_id: 'cli_lark',
          client_secret: 'sec_lark',
          user_info: { open_id: 'ou_lark', tenant_brand: 'lark' },
        });
      }),
    );
    const res = await pollRegistration('dev_lark', 1, 60, 'lark');
    expect(fetchedUrls[0]).toContain('https://accounts.larksuite.com');
    expect(res).not.toBeNull();
    expect(res?.domain).toBe('lark');
    expect(res?.appId).toBe('cli_lark');
  });

  it('auto-switches a feishu-seeded poll to lark when tenant_brand says lark', async () => {
    // 这是兜底自动切换逻辑：即便从 feishu 起手，扫码者是 Lark 租户也会被纠正。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(String(url));
        return makeResponse({
          client_id: 'cli_x',
          client_secret: 'sec_x',
          user_info: { open_id: 'ou_x', tenant_brand: 'lark' },
        });
      }),
    );
    const res = await pollRegistration('dev_x', 1, 60, 'feishu');
    expect(res?.domain).toBe('lark');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// probeCredentials — token / bot 校验接口打到正确的 open.* 域名
// ───────────────────────────────────────────────────────────────────────────
describe('probeCredentials domain routing', () => {
  it('calls open.larksuite.com for a lark credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(String(url));
        if (String(url).includes('tenant_access_token')) {
          return makeResponse({ tenant_access_token: 'tok_lark' });
        }
        if (String(url).includes('/bot/v3/info')) {
          return makeResponse({ code: 0, bot: { app_name: 'LarkBot', open_id: 'ou_bot' } });
        }
        // applications/me（best-effort scope 查询）— 返回 403 即可，不影响主流程
        return makeResponse({ code: 99991663 }, 403);
      }),
    );
    const res = await probeCredentials('cli_lark', 'sec_lark', 'lark');
    expect(fetchedUrls.every((u) => u.includes('open.larksuite.com'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('feishu'))).toBe(false);
    expect(res?.botName).toBe('LarkBot');
  });

  it('calls open.feishu.cn for a feishu credential (regression guard)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrls.push(String(url));
        if (String(url).includes('tenant_access_token')) {
          return makeResponse({ tenant_access_token: 'tok_fs' });
        }
        if (String(url).includes('/bot/v3/info')) {
          return makeResponse({ code: 0, bot: { app_name: 'FeishuBot', open_id: 'ou_bot' } });
        }
        return makeResponse({ code: 99991663 }, 403);
      }),
    );
    const res = await probeCredentials('cli_fs', 'sec_fs', 'feishu');
    expect(fetchedUrls.every((u) => u.includes('open.feishu.cn'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('larksuite'))).toBe(false);
    expect(res?.botName).toBe('FeishuBot');
  });
});
