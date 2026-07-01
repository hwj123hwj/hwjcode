/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Identifies Feishu-gateway sessions so the desktop can exclude them from its
 * own session list. Kept separate from `sessionHub.ts` (which imports `electron`)
 * so this pure predicate is unit-testable in isolation.
 *
 * When the standalone CLI's Feishu gateway shares this machine's session store,
 * conversations users hold inside Feishu are persisted as core sessions whose id
 * follows `feishu-<chatId>-<timestamp>` (see the CLI's feishuCommand). Those can
 * bleed into the desktop's list, where they render broken — only the user's
 * turns show, never the agent's replies — because the desktop never drove them.
 * The desktop should only ever surface sessions it created itself, so we drop
 * anything carrying this Feishu marker (on either the desktop record id or the
 * backend `acpSessionId` it resumes through).
 */

/** Prefix every Feishu-gateway session id/acpSessionId starts with. */
export const FEISHU_SESSION_PREFIX = 'feishu-';

/**
 * True when a persisted session record originates from the Feishu gateway and
 * should be hidden from the desktop. Matches on the desktop record `id` OR the
 * backend `acpSessionId` (either may carry the `feishu-…` id, depending on how
 * the record was persisted). Desktop-created sessions use random UUIDs for both,
 * so this never matches a legitimate session (including a normal chat where the
 * user merely ran a `/feishu …` command).
 */
export function isFeishuGatewaySession(rec: {
  id?: string;
  acpSessionId?: string;
}): boolean {
  return (
    (rec.id ?? '').startsWith(FEISHU_SESSION_PREFIX) ||
    (rec.acpSessionId ?? '').startsWith(FEISHU_SESSION_PREFIX)
  );
}
