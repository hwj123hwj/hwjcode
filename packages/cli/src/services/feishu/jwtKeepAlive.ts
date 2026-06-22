/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书网关下的 JWT 主动保活。
 *
 * 背景：core 的 `ProxyAuthManager` 的续期是【请求时惰性触发】的——只有真正发出
 * API 请求、走到 `getAccessToken()` 时才会检查 token 是否临近过期（提前 3 天）并
 * 自动 refresh。飞书 bot 可能长时间空闲，没有任何请求，于是 token 会一路逼近真实
 * 过期点；若空闲时长超过 refresh token 的寿命，下次来消息时续期就会失败，用户在
 * 飞书里只能看到「登录失效」。
 *
 * 解决：飞书网关启动后挂一个周期性保活定时器，定期主动调用 `getAccessToken()`，
 * 借用 core 已有的「临近过期即 refresh」逻辑，让空闲 bot 也能在后台持续续期。
 *
 * 本模块只负责【周期性触发 + 异常兜底】这一薄层；真正的「判断是否临近过期 / 执行
 * refresh」逻辑仍在 core 的 ProxyAuthManager 内（已被 core 单测覆盖），不重复实现。
 */

/**
 * 保活触发间隔。
 *
 * core 的临近过期阈值是 3 天（`TOKEN_REFRESH_THRESHOLD_SECONDS`）。保活间隔需远小于
 * 该窗口，确保 3 天窗口内会被触发很多次——即便个别 tick 因网络抖动失败，后续 tick
 * 仍有充足机会在 token 真正过期前续期成功。取 6 小时：3 天窗口内可触发 12 次。
 */
export const FEISHU_JWT_KEEPALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 保活日志记录器签名（注入便于单测）。 */
export type KeepAliveLogger = (message: string) => void;

/**
 * 执行一次 JWT 保活：调用注入的 `getAccessToken`，触发 core 的临近过期检查 + 续期。
 *
 * 该函数【绝不抛出】——任何失败都被吞掉并记日志，确保承载它的 setInterval 回调不会
 * 因未捕获异常而中断保活循环或拖垮网关进程。
 *
 * @param getAccessToken core `ProxyAuthManager.getAccessToken` 的绑定引用。
 * @param log 可选日志记录器；缺省时静默。
 * @returns 是否成功拿到有效 token（true 表示登录态健康）。
 */
export async function performJwtKeepAlive(
  getAccessToken: () => Promise<string | null>,
  log?: KeepAliveLogger,
): Promise<boolean> {
  try {
    const token = await getAccessToken();
    if (token) {
      return true;
    }
    log?.(
      '[Feishu JWT KeepAlive] No valid token after refresh attempt — login may have expired; user needs to re-run /auth.',
    );
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`[Feishu JWT KeepAlive] Keep-alive failed: ${msg}`);
    return false;
  }
}
