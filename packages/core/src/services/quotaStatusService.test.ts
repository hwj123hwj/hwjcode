/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QuotaStatusService, type QuotaStatus } from './quotaStatusService.js';

/** 构造一个可控的 QuotaStatus 测试夹具 */
function makeStatus(overrides?: Partial<QuotaStatus>): QuotaStatus {
  return {
    userUuid: 'u-1',
    roleModelQuota: {
      whitelisted: false,
      models: [],
    },
    dailyQuota: {
      enabled: false,
      whitelisted: false,
      limit: 0,
      used: 0,
      remaining: 0,
      resetAt: null,
    },
    zhWeeklyQuota: {
      applicable: false,
      enabled: false,
      whitelisted: false,
      limit: 0,
      used: 0,
      remaining: 0,
      resetAt: null,
    },
    ...overrides,
  };
}

describe('QuotaStatusService', () => {
  let svc: QuotaStatusService;

  beforeEach(() => {
    svc = QuotaStatusService.getInstance();
    // 重置单例内部缓存，避免用例间互相污染
    (svc as unknown as { cache: unknown }).cache = null;
  });

  describe('isQuotaLowForModel', () => {
    it('deepseek-v4 系列直接豁免，不检查配额', () => {
      const r = svc.isQuotaLowForModel('deepseek-v4-pro');
      expect(r.low).toBe(false);
      expect(r.exempt).toBe(true);
    });

    it('尚未拉取（无缓存）时不拦截', () => {
      const r = svc.isQuotaLowForModel('claude-opus-4');
      expect(r.low).toBe(false);
    });

    it('白名单用户不拦截', () => {
      (svc as unknown as { cache: { data: QuotaStatus } }).cache = {
        data: makeStatus({
          roleModelQuota: { whitelisted: true, models: [] },
        }),
      } as never;
      const r = svc.isQuotaLowForModel('claude-opus-4');
      expect(r.low).toBe(false);
    });

    it('剩余为 0 时报告已用尽', () => {
      (svc as unknown as { cache: { data: QuotaStatus } }).cache = {
        data: makeStatus({
          roleModelQuota: {
            whitelisted: false,
            models: [
              {
                modelId: 'claude-opus-4',
                role: 'pro',
                cycle: 'daily',
                limit: 10000,
                used: 10000,
                remaining: 0,
                cycleKey: 'k',
              },
            ],
          },
        }),
      } as never;
      const r = svc.isQuotaLowForModel('claude-opus-4');
      expect(r.low).toBe(true);
      expect(r.message).toContain('用尽');
    });

    it('剩余低于绝对阈值(2000)时报告不足', () => {
      (svc as unknown as { cache: { data: QuotaStatus } }).cache = {
        data: makeStatus({
          roleModelQuota: {
            whitelisted: false,
            models: [
              {
                modelId: 'claude-opus-4',
                role: 'pro',
                cycle: 'daily',
                limit: 100000,
                used: 98500,
                remaining: 1500,
                cycleKey: 'k',
              },
            ],
          },
        }),
      } as never;
      const r = svc.isQuotaLowForModel('claude-opus-4');
      expect(r.low).toBe(true);
    });

    it('剩余充足时不拦截', () => {
      (svc as unknown as { cache: { data: QuotaStatus } }).cache = {
        data: makeStatus({
          roleModelQuota: {
            whitelisted: false,
            models: [
              {
                modelId: 'claude-opus-4',
                role: 'pro',
                cycle: 'daily',
                limit: 100000,
                used: 10000,
                remaining: 90000,
                cycleKey: 'k',
              },
            ],
          },
        }),
      } as never;
      const r = svc.isQuotaLowForModel('claude-opus-4');
      expect(r.low).toBe(false);
    });

    it('支持 modelIds 逗号分隔匹配', () => {
      (svc as unknown as { cache: { data: QuotaStatus } }).cache = {
        data: makeStatus({
          roleModelQuota: {
            whitelisted: false,
            models: [
              {
                modelId: 'claude-opus-4',
                modelIds: 'claude-opus-4,claude-opus-4-8',
                role: 'pro',
                cycle: 'daily',
                limit: 100000,
                used: 100000,
                remaining: 0,
                cycleKey: 'k',
              } as never,
            ],
          },
        }),
      } as never;
      const r = svc.isQuotaLowForModel('claude-opus-4-8');
      expect(r.low).toBe(true);
    });
  });

  describe('buildFooterSummary', () => {
    it('无数据返回空串', () => {
      expect(svc.buildFooterSummary(undefined, 'claude-opus-4')).toBe('');
    });

    it('单行、无 emoji，含模型配额剩余百分比', () => {
      const status = makeStatus({
        roleModelQuota: {
          whitelisted: false,
          models: [
            {
              modelId: 'claude-opus-4',
              role: 'pro',
              cycle: 'daily',
              limit: 100000,
              used: 25000,
              remaining: 75000,
              cycleKey: 'k',
            },
          ],
        },
      });
      const summary = svc.buildFooterSummary(status, 'claude-opus-4');
      // 不含换行（单行）
      expect(summary).not.toContain('\n');
      // 不含 emoji（用 buildSummary 中出现的 📊 做反向校验）
      expect(summary).not.toContain('📊');
      expect(summary).not.toContain('📅');
      // 25% 已用 → 剩余 75%
      expect(summary).toContain('75%');
      expect(summary).toContain('日剩余');
    });

    it('白名单用户显示白名单标记', () => {
      const status = makeStatus({
        roleModelQuota: { whitelisted: true, models: [] },
      });
      const summary = svc.buildFooterSummary(status, 'claude-opus-4');
      expect(summary).toContain('白名单');
    });

    it('包含日积分与珠海周积分', () => {
      const status = makeStatus({
        dailyQuota: {
          enabled: true,
          whitelisted: false,
          limit: 1000,
          used: 100,
          remaining: 900,
          resetAt: null,
        },
        zhWeeklyQuota: {
          applicable: true,
          enabled: true,
          whitelisted: false,
          limit: 5000,
          used: 1000,
          remaining: 4000,
          resetAt: null,
        },
      });
      const summary = svc.buildFooterSummary(status);
      expect(summary).toContain('今日 剩余 90%');
      expect(summary).toContain('珠海周 剩余 80%');
      // 多段用 ' · ' 连接
      expect(summary).toContain(' · ');
    });

    it('只显示与当前模型匹配的配额条目', () => {
      const status = makeStatus({
        roleModelQuota: {
          whitelisted: false,
          models: [
            {
              modelId: 'claude-opus-4',
              role: 'pro',
              cycle: 'daily',
              limit: 100,
              used: 50,
              remaining: 50,
              cycleKey: 'a',
            },
            {
              modelId: 'gpt-5',
              role: 'pro',
              cycle: 'weekly',
              limit: 100,
              used: 90,
              remaining: 10,
              cycleKey: 'b',
            },
          ],
        },
      });
      const summary = svc.buildFooterSummary(status, 'claude-opus-4');
      // 只应出现 opus 的日配额（剩余 50%），不出现 gpt-5 的周配额（剩余 10%）
      expect(summary).toContain('日剩余 50%');
      expect(summary).not.toContain('10%');
    });
  });
});
