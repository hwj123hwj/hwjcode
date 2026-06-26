/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lightweight YAML frontmatter parser — replaces gray-matter to avoid the
 * bundled js-yaml@3.x CVE (GHSA-h67p-54hq-rp68, quadratic-complexity DoS).
 * Uses yaml@2.x which is actively maintained and vulnerability-free.
 */

import { parse as parseYaml } from 'yaml';

export interface FrontmatterResult {
  /** Parsed YAML front-matter data (empty object if none). */
  data: Record<string, unknown>;
  /** The body content after the closing `---` delimiter. */
  content: string;
}

/**
 * Parse a Markdown string that may have a YAML front-matter block.
 *
 * Supports both `---\n...\n---\n` (standard) and `---\r\n...\r\n---\r\n`
 * (Windows line endings).  Returns `{ data: {}, content: raw }` when no
 * front-matter is present or parsing fails.
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, content: raw };
  }

  try {
    const parsed = parseYaml(match[1]);
    const data: Record<string, unknown> =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { data, content: match[2] };
  } catch {
    // Malformed YAML — return the body without metadata rather than throwing.
    return { data: {}, content: match[2] };
  }
}
