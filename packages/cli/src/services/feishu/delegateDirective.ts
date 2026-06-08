/**
 * @license
 * Copyright 2025 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the Feishu "explicit dispatch" track: deciding when an
 * incoming message should be forcibly delegated to an external agent (Claude
 * Code today), and building the directive that forces Easy Code's agent loop to
 * call the `delegate_to_claude_code` tool.
 *
 * Kept free of any Feishu/runtime dependencies so it can be unit-tested in
 * isolation (the surrounding feishuCommand module is too large to exercise).
 */

/** External agents that a Feishu chat can be routed to. `self` means Easy Code. */
export type FeishuAgentTarget = 'self' | 'claude-code';

/** Leading prefixes that force per-message delegation to Claude Code. */
const CLAUDE_PREFIX_RE = /^[@/](cc|claudecode|claude-code)(?=$|[\s:：])[\s:：]*/i;

export interface DelegationDecision {
  /** Whether this message should be delegated to an external agent. */
  delegate: boolean;
  /** Target agent when delegating. */
  agent: Exclude<FeishuAgentTarget, 'self'>;
  /** The task text to hand off (prefix stripped). */
  task: string;
  /** Why we decided to delegate ('prefix' | 'route' | 'none'). */
  reason: 'prefix' | 'route' | 'none';
}

/**
 * Strip a leading `@cc` / `/cc` (and aliases) delegation prefix.
 * Returns whether it matched and the remaining task text.
 */
export function parseDelegatePrefix(text: string): {
  matched: boolean;
  task: string;
} {
  const raw = text ?? '';
  const m = raw.match(CLAUDE_PREFIX_RE);
  if (!m) return { matched: false, task: raw.trim() };
  return { matched: true, task: raw.slice(m[0].length).trim() };
}

/**
 * Decide whether to delegate, combining the per-message prefix (highest
 * priority) with the chat's default agent route.
 */
export function resolveDelegation(
  text: string,
  defaultAgent?: FeishuAgentTarget,
): DelegationDecision {
  const prefix = parseDelegatePrefix(text);
  if (prefix.matched) {
    return { delegate: true, agent: 'claude-code', task: prefix.task, reason: 'prefix' };
  }
  if (defaultAgent === 'claude-code') {
    return {
      delegate: true,
      agent: 'claude-code',
      task: (text ?? '').trim(),
      reason: 'route',
    };
  }
  return { delegate: false, agent: 'claude-code', task: (text ?? '').trim(), reason: 'none' };
}

/**
 * Build the message handed to Easy Code's agent loop so it is forced to delegate
 * via the `delegate_to_claude_code` tool instead of doing the work itself. The
 * tool's streaming output then flows to the Feishu card unchanged.
 */
export function buildDelegateDirective(task: string): string {
  return [
    '【强制派发指令】用户要求将以下任务交给本机的 Claude Code 执行。',
    '你必须立即调用 delegate_to_claude_code 工具，task 参数填写下面的完整原文。',
    '不要自己动手处理这个任务，也不要追问，直接派发：',
    '',
    task,
  ].join('\n');
}

/**
 * Parse the optional `--agent <self|claude-code>` flag out of a `/bind` command
 * argument string. Returns the recognized agent (if any) and the remaining
 * tokens with the flag removed (so the path argument can still be parsed).
 */
export function parseBindAgentFlag(argString: string): {
  agent?: FeishuAgentTarget;
  rest: string;
} {
  const tokens = (argString ?? '').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let agent: FeishuAgentTarget | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--agent' || t === '-a') {
      const val = (tokens[i + 1] ?? '').toLowerCase();
      i++; // always consume the value token, even if invalid
      if (val === 'self' || val === 'claude-code' || val === 'cc') {
        agent = val === 'cc' ? 'claude-code' : (val as FeishuAgentTarget);
      }
      continue;
    }
    const inline = t.match(/^--agent=(\S+)$/i);
    if (inline) {
      const val = inline[1].toLowerCase();
      if (val === 'self' || val === 'claude-code' || val === 'cc') {
        agent = val === 'cc' ? 'claude-code' : (val as FeishuAgentTarget);
      }
      continue;
    }
    out.push(t);
  }
  return { agent, rest: out.join(' ') };
}
