/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure helpers for the desktop's Feishu slash-command pass-through.
 *
 * The desktop does NOT reimplement `/feishu allow|deny|owner` logic. It spawns
 * the bundled backend non-interactively (`easycode -p "/feishu <args>"`), which
 * runs the exact same `feishuCommand` handlers the CLI/TUI use (loaded via
 * BuiltinCommandLoader) and writes the shared credential store. These helpers
 * cover the bits worth unit-testing in isolation from Electron / child_process:
 * the subcommand allowlist, argv assembly, and stdout parsing. The spawn itself
 * lives in {@link FeishuManager.runFeishuCommand}.
 */

/**
 * The only `/feishu` subcommands the desktop authorization UI is allowed to
 * drive through the pass-through channel. This is a safety boundary: the same
 * non-interactive entry could in principle run `logout` / `stop` / `setup`, so
 * we whitelist just the authorization-management verbs the GUI needs and reject
 * everything else before spawning anything.
 */
export const FEISHU_AUTH_SUBCOMMANDS = [
  'allow',
  'deny',
  'owner',
  'allowlist',
] as const;

export type FeishuAuthSubcommand = (typeof FEISHU_AUTH_SUBCOMMANDS)[number];

/**
 * True when `args` begins with a whitelisted authorization subcommand (the
 * verb must be a standalone token, e.g. `allow ou_x`, not `allowfoo`). Empty /
 * unknown input is rejected.
 */
export function isAllowedFeishuAuthCommand(args: string): boolean {
  const trimmed = (args ?? '').trim();
  if (!trimmed) return false;
  const verb = trimmed.split(/\s+/, 1)[0];
  return (FEISHU_AUTH_SUBCOMMANDS as readonly string[]).includes(verb);
}

/**
 * Assemble the argv for the one-shot backend spawn. The whole `/feishu <args>`
 * string is passed as a SINGLE argv element to `-p` (no shell), so an open_id
 * with odd characters can never break out into shell metacharacters. `json`
 * output mode yields one final `{ content, status }` object that
 * {@link parseFeishuCommandStdout} reads.
 */
export function buildFeishuCommandArgs(backendEntry: string, args: string): string[] {
  const prompt = `/feishu ${(args ?? '').trim()}`.trim();
  return [backendEntry, '-p', prompt, '--output-format', 'json'];
}

/** Structured result extracted from the backend's stdout. */
export interface FeishuCommandOutput {
  /** The human-readable command result text (the message the handler returned). */
  message?: string;
  /** Whether the command reported success or error. */
  status?: 'success' | 'error';
  /** An error string, when the backend emitted one explicitly. */
  error?: string;
}

/**
 * Parse the backend's stdout into {@link FeishuCommandOutput}.
 *
 * Tolerant of both output formats so the caller can switch freely:
 *  - `--output-format json`: one final object `{ model, content, status, error? }`.
 *  - `--output-format stream-json`: line-delimited events — `{type:'message',
 *    role:'assistant', content}`, `{type:'result', status}`, `{type:'error', error}`.
 *
 * Non-JSON lines (boot logs, banners) are skipped. Later JSON values win, so the
 * final result object / last assistant message is what's reported.
 */
export function parseFeishuCommandStdout(stdout: string): FeishuCommandOutput {
  const out: FeishuCommandOutput = {};
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    // json mode: final object carries both content and status.
    if (
      typeof obj.content === 'string' &&
      (obj.status === 'success' || obj.status === 'error')
    ) {
      out.message = obj.content;
      out.status = obj.status;
      if (typeof obj.error === 'string') out.error = obj.error;
      continue;
    }
    // stream-json: assistant message event.
    if (
      obj.type === 'message' &&
      obj.role === 'assistant' &&
      typeof obj.content === 'string'
    ) {
      out.message = obj.content;
      continue;
    }
    // stream-json: final result event.
    if (obj.type === 'result' && (obj.status === 'success' || obj.status === 'error')) {
      out.status = obj.status;
      continue;
    }
    // stream-json / json: explicit error event.
    if (obj.type === 'error' && typeof obj.error === 'string') {
      out.error = obj.error;
      out.status = 'error';
    }
  }
  return out;
}
