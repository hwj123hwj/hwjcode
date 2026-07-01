/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure helpers for the desktop's full-text session search (the ⌘/Ctrl-search
 * command palette). Kept free of `electron`/`fs` so the path derivation, history
 * parsing, and snippet building are unit-testable in isolation; `sessionHub.ts`
 * does the actual file reads and calls these.
 *
 * Core persists each session's transcript to
 *   ~/.easycode-user/tmp/<sha256(cwd)>/sessions/<acpSessionId>/history.json
 * (see core's `paths.ts` getProjectTempDir / `sessionManager.ts`). Its shape is a
 * Gemini-style content array: `[{ role, parts: [{ text }] }]`.
 */

import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

// Mirrors core's `paths.ts` (GEMINI_DIR / TMP_DIR_NAME). Replicated rather than
// imported so the desktop main bundle doesn't pull in the core package.
const USER_DIR = '.easycode-user';
const TMP_DIR_NAME = 'tmp';

/** Characters of surrounding context kept on each side of a content match. */
export const SNIPPET_RADIUS = 60;

/**
 * Absolute path to a session's persisted transcript, derived from its working
 * directory and backend (acp) session id — the same layout core writes.
 */
export function sessionHistoryPath(cwd: string, acpSessionId: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex');
  return path.join(os.homedir(), USER_DIR, TMP_DIR_NAME, hash, 'sessions', acpSessionId, 'history.json');
}

/** Strip `<system-reminder>…</system-reminder>` blocks core injects into turns. */
const SYSTEM_REMINDER_RE = /<system[\s-]?reminder>[\s\S]*?<\/system[\s-]?reminder>/gi;

/**
 * True for the big system-context preamble core prepends as the first user turn
 * (date/platform/tooling guidance). Skipped so a search never matches boilerplate
 * that isn't part of the actual conversation.
 */
function isInjectedContext(text: string): boolean {
  return text.includes('CRITICAL SYSTEM CONTEXT') || text.trimStart().startsWith('🚀');
}

/**
 * Extract the human-meaningful text segments from a parsed `history.json`. Skips
 * injected system context and reminder blocks, and collapses whitespace so
 * snippets read as one line. Tolerant of unexpected shapes (returns []).
 */
export function extractHistoryText(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const msg of raw) {
    const parts = (msg as { parts?: unknown })?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text !== 'string' || !text) continue;
      if (isInjectedContext(text)) continue;
      const cleaned = text.replace(SYSTEM_REMINDER_RE, '').replace(/\s+/g, ' ').trim();
      if (cleaned) out.push(cleaned);
    }
  }
  return out;
}

/**
 * A snippet of `text` centred on the first (case-insensitive) match of `query`,
 * with leading/trailing ellipses when it's clipped — or null if `query` isn't in
 * `text`. `query` is assumed already trimmed/non-empty.
 */
export function buildSnippet(text: string, query: string, radius = SNIPPET_RADIUS): string | null {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/**
 * Find the first content snippet across a session's extracted `texts` that
 * contains `query`, or null if none do. `query` is assumed trimmed/non-empty.
 */
export function findSnippet(texts: string[], query: string): string | null {
  for (const t of texts) {
    const s = buildSnippet(t, query);
    if (s) return s;
  }
  return null;
}
