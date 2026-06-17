/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure helpers for deriving a sidebar session title from user input. Kept free
 * of renderer/IPC dependencies so the logic is unit-testable in isolation.
 */

/** Max characters of the first user message used as a provisional session title. */
export const PROVISIONAL_TITLE_MAX = 30;

/**
 * Strip the "[IMAGE: name (path)]" hints we append to a prompt for the backend's
 * image_reader tool, so a derived title shows clean user text rather than the
 * raw on-disk path.
 */
export function stripImageHints(text: string): string {
  return text.replace(/\n*\[IMAGE:[^\]]*\][ \t]*/g, '').trim();
}

/**
 * Derive a short sidebar title from a user's first message: strip image hints,
 * collapse whitespace to single spaces, and truncate to
 * {@link PROVISIONAL_TITLE_MAX} chars (with an ellipsis when cut). Returns '' if
 * there's nothing usable, in which case the caller keeps the existing title.
 */
export function deriveTitleFromMessage(text: string): string {
  const cleaned = stripImageHints(text).replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= PROVISIONAL_TITLE_MAX) return cleaned;
  return cleaned.slice(0, PROVISIONAL_TITLE_MAX) + '…';
}
