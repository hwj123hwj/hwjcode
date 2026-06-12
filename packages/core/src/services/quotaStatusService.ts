/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 用户限额状态服务 (Quota Status Service)
 *
 * 调用服务端 /web-api/user/quota-status 接口获取当前用户的
 * 角色×模型配额、日积分限额、珠海飞书周限额。
 *
 * 拉取时机（事件驱动）：
 *   - 启动/进入会话时拉取一次
 *   - 会话忙→闲（setIsResponding(false)）时拉取
 *
 * 消费方：
 *   - CLI 闲时 UI 打印（不进历史）
 *   - CLI 发送消息前拦截（配额不足警告）
 */

import { ProxyAuthManager } from '../core/proxyAuth.js';
import { getUserAgent } from '../utils/userAgent.js';

/** API 返回的单个模型配额条目 */
export interface RoleModelQuotaItem {
  modelId: string;
  role: string;
  cycle: 'daily' | 'weekly' | 'monthly' | 'infinite';
  limit: number;
  used: number;
  remaining: number;
  cycleKey: string;
}

/** API 返回的日积分限额 */
export interface DailyQuota {
  enabled: boolean;
  whitelisted: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
}

/** API 返回的珠海飞书周限额 */
export interface ZhWeeklyQuota {
  applicable: boolean;
  enabled: boolean;
  whitelisted: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
}

/** 限额状态 API 响应 */
export interface QuotaStatus {
  userUuid: string;
  roleModelQuota: {
    whitelisted: boolean;
    models: RoleModelQuotaItem[];
  };
  dailyQuota: DailyQuota;
  zhWeeklyQuota: ZhWeeklyQuota;
}

/** 带时间戳的缓存 */
interface CachedQuota {
  data: QuotaStatus;
  fetchedAt: number;
}

/** 服务端响应结构 */
interface QuotaApiResponse {
  success: boolean;
  data?: QuotaStatus;
  message?: string;
}

/** 警告阈值 */
const QUOTA_LOW_CREDITS = 2000;
const QUOTA_LOW_PERCENT = 0.1;

/** deepseek-v4 系列模型名匹配 */
const DEEPSEEK_V4_PATTERN = /^deepseek-v4/i;

export class QuotaStatusService {
  private static instance: QuotaStatusService;
  private cache: CachedQuota | null = null;

  private constructor() {}

  static getInstance(): QuotaStatusService {
    if (!QuotaStatusService.instance) {
      QuotaStatusService.instance = new QuotaStatusService();
    }
    return QuotaStatusService.instance;
  }

  // ── 公开 API ──────────────────────────────────────────

  /** 主动拉取限额状态（覆盖缓存） */
  async fetchQuotaStatus(): Promise<QuotaStatus | null> {
    try {
      const token = await ProxyAuthManager.getInstance().getAccessToken();
      if (!token) {
        return null;
      }
      const serverUrl =
        process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai';
      const url = `${serverUrl}/web-api/user/quota-status`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': getUserAgent(),
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return null;
      }

      const json: QuotaApiResponse = await response.json();
      if (!json.success || !json.data) {
        return null;
      }

      this.cache = {
        data: json.data,
        fetchedAt: Date.now(),
      };
      return json.data;
    } catch {
      return null;
    }
  }

  /** 读取上次缓存（不发起请求） */
  getCachedStatus(): QuotaStatus | null {
    return this.cache?.data ?? null;
  }

  /**
   * 检查指定模型是否「配额不足」— 满足任一条件即警告：
   *   remaining <= 0，或 remaining < 2000，或 remaining/limit < 10%
   *
   * deepseek-v4* 系列直接返回 exempt（不检查）。
   */
  isQuotaLowForModel(modelId: string): {
    low: boolean;
    message?: string;
    item?: RoleModelQuotaItem;
    exempt?: boolean;
  } {
    if (DEEPSEEK_V4_PATTERN.test(modelId)) {
      return { low: false, exempt: true };
    }

    const status = this.cache?.data;
    if (!status) {
      return { low: false }; // 尚未拉取，不阻挡
    }

    const { roleModelQuota } = status;
    if (roleModelQuota.whitelisted) {
      return { low: false };
    }

    // 精确匹配当前模型
    let item = roleModelQuota.models.find(
      (m) => m.modelId.toLowerCase() === modelId.toLowerCase(),
    );
    // 若精确匹配失败，尝试用逗号分隔的 modelIds 字段匹配
    if (!item) {
      item = roleModelQuota.models.find((m) => {
        // 某些条目 modelId 可能包含多个 id 逗号分隔（如 "claude-opus-4,claude-opus-4-8"）
        return (m as any).modelIds
          ?.split(',')
          .some((id: string) => id.trim().toLowerCase() === modelId.toLowerCase());
      });
    }

    if (!item) {
      return { low: false }; // 无该模型单独配额，不拦截
    }

    if (item.remaining <= 0) {
      return {
        low: true,
        message: `当前模型 ${modelId} 积分已用尽（总额 ${Math.round(item.limit)}）。建议使用 /model 切换模型。`,
        item,
      };
    }

    const ratio = item.limit > 0 ? item.remaining / item.limit : 1;
    if (item.remaining < QUOTA_LOW_CREDITS || ratio < QUOTA_LOW_PERCENT) {
      return {
        low: true,
        message: `当前模型 ${modelId} 剩余积分不足（${Math.round(item.remaining)}/${Math.round(item.limit)}，剩余 ${Math.round(ratio * 100)}%）。长任务可能无法完成，建议使用 /model 切换模型。`,
        item,
      };
    }

    return { low: false, item };
  }

  /**
   * 生成终端展示用的限额摘要文本（不进历史上下文）。
   * 只显示与 currentModel 匹配的模型配额 + 日积分 + 周积分，积分取整。
   */
  buildSummary(status?: QuotaStatus, currentModel?: string): string {
    const s = status ?? this.cache?.data;
    if (!s) return '';

    const lines: string[] = [];
    const pct = (used: number, limit: number) =>
      limit > 0 ? `${Math.round((1 - used / limit) * 100)}%` : '--';
    const cycleLabel = (c: string) =>
      ({ daily: '日', weekly: '周', monthly: '月' } as Record<string, string>)[c] || '';

    // 模型是否匹配当前会话使用的模型
    const modelMatches = (m: RoleModelQuotaItem) => {
      if (!currentModel) return true;
      if (m.modelId.toLowerCase() === currentModel.toLowerCase()) return true;
      return (m as any).modelIds
        ?.split(',')
        .some((id: string) => id.trim().toLowerCase() === currentModel.toLowerCase());
    };

    // 角色×模型配额（只显示与当前模型匹配的，减少打扰）
    if (s.roleModelQuota.models.length > 0) {
      const matched = s.roleModelQuota.models.filter(modelMatches);
      if (matched.length > 0) {
        lines.push('📊 模型配额');
        for (const m of matched) {
          const cl = cycleLabel(m.cycle);
          lines.push(
            `   ${m.modelId}  ${cl}${Math.round(m.limit)} 积分  剩余 ${pct(m.used, m.limit)}`,
          );
        }
      }
    } else if (s.roleModelQuota.whitelisted) {
      lines.push('📊 模型配额: 白名单用户，不受限制');
    }

    // 日积分
    if (s.dailyQuota.enabled && !s.dailyQuota.whitelisted) {
      lines.push(
        `📅 今日积分  ${Math.round(s.dailyQuota.limit)}  剩余 ${pct(s.dailyQuota.used, s.dailyQuota.limit)}`,
      );
    }

    // 珠海周积分
    if (s.zhWeeklyQuota.applicable && s.zhWeeklyQuota.enabled) {
      lines.push(
        `🌊 珠海周积分  ${Math.round(s.zhWeeklyQuota.limit)}  剩余 ${pct(s.zhWeeklyQuota.used, s.zhWeeklyQuota.limit)}`,
      );
    }

    if (lines.length === 0) return '';
    lines.push('');
    lines.push('💡 deepseek-v4 系列不受上述配额限制');

    return lines.join('\n');
  }

  /**
   * 生成单行、无 emoji 的紧凑配额摘要，供飞书卡片 footer 拼接使用。
   * 只显示与 currentModel 匹配的模型配额 + 日积分 + 周积分，用 " · " 连接。
   * 无可展示内容时返回空串。
   */
  buildFooterSummary(status?: QuotaStatus, currentModel?: string): string {
    const s = status ?? this.cache?.data;
    if (!s) return '';

    const parts: string[] = [];
    const pct = (used: number, limit: number) =>
      limit > 0 ? `${Math.round((1 - used / limit) * 100)}%` : '--';
    const cycleLabel = (c: string) =>
      ({ daily: '日', weekly: '周', monthly: '月' } as Record<string, string>)[c] || '';

    const modelMatches = (m: RoleModelQuotaItem) => {
      if (!currentModel) return true;
      if (m.modelId.toLowerCase() === currentModel.toLowerCase()) return true;
      return (m as any).modelIds
        ?.split(',')
        .some(
          (id: string) => id.trim().toLowerCase() === currentModel.toLowerCase(),
        );
    };

    // 角色×模型配额（只显示与当前模型匹配的）
    if (s.roleModelQuota.models.length > 0) {
      const matched = s.roleModelQuota.models.filter(modelMatches);
      for (const m of matched) {
        const cl = cycleLabel(m.cycle);
        parts.push(`配额 ${cl}剩余 ${pct(m.used, m.limit)}`);
      }
    } else if (s.roleModelQuota.whitelisted) {
      parts.push('配额 白名单');
    }

    // 日积分
    if (s.dailyQuota.enabled && !s.dailyQuota.whitelisted) {
      parts.push(`今日 剩余 ${pct(s.dailyQuota.used, s.dailyQuota.limit)}`);
    }

    // 珠海周积分
    if (s.zhWeeklyQuota.applicable && s.zhWeeklyQuota.enabled) {
      parts.push(`珠海周 剩余 ${pct(s.zhWeeklyQuota.used, s.zhWeeklyQuota.limit)}`);
    }

    return parts.join(' · ');
  }
}
