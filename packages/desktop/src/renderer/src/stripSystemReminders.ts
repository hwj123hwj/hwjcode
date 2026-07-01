/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure display-layer filter that removes `<system-reminder>…</system-reminder>`
 * blocks from message text. These are dynamic system prompts core injects into
 * message content (e.g. stale-todo nudges, environment context) and should never
 * be shown to the user.
 *
 * Renderer-only: this runs at render time in {@link ChatPane}; the store keeps
 * the original, unmodified message text so rewind/resend and persistence see the
 * real content.
 */

// Paired reminder block, non-greedy so multiple blocks in one message each match
// independently. `[\s\S]` spans newlines (multiline blocks). The tag separator is
// tolerant (hyphen / space / none) and matching is case-insensitive, so variant
// spellings of the tag are still stripped.
const SYSTEM_REMINDER_RE =
  /<system[\s-]?reminder>[\s\S]*?<\/system[\s-]?reminder>/gi;

/**
 * Strip every `<system-reminder>…</system-reminder>` block from `text`, then
 * collapse the blank runs a removed block leaves behind (3+ newlines → 2) and
 * trim the ends — so a message that was *only* a reminder renders as empty.
 */
export function stripSystemReminders(text: string): string {
  if (!text) return text;
  return text.replace(SYSTEM_REMINDER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}
