/**
 * @license
 * Copyright 2025 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the Feishu "explicit dispatch" track: deciding when an
 * incoming message should be forcibly delegated to an external agent
 * (Claude Code or Codex), and building the directive that forces Easy Code's
 * agent loop to call the `delegate_to_claude_code` tool with the right
 * `agent` argument.
 *
 * Kept free of any Feishu/runtime dependencies so it can be unit-tested in
 * isolation (the surrounding feishuCommand module is too large to exercise).
 */

/** External agents that a Feishu chat can be routed to. `self` means Easy Code. */
export type FeishuAgentTarget = 'self' | 'claude-code' | 'codex';

/** Subset of agents that map to the ACP delegate path. */
export type FeishuDelegateAgent = Exclude<FeishuAgentTarget, 'self'>;

/**
 * Leading prefixes that force per-message delegation. The matched `target`
 * group selects which external agent to route to. Both groups are mutually
 * exclusive — exactly one of them captures.
 */
const DELEGATE_PREFIX_RE =
  /^[@/](?:(?<cc>cc|claudecode|claude-code)|(?<cdx>codex|cdx))(?=$|[\s:：])[\s:：]*/i;

const AGENT_LABELS: Record<FeishuDelegateAgent, string> = {
  'claude-code': '本机 Claude Code',
  'codex': '本机 Codex',
};

const SELF_LABEL = 'Easy Code 自己';

/** Stable identifiers for the agents accepted by `--agent` / `-a`. */
const BIND_AGENT_ALIASES: Record<string, FeishuAgentTarget> = {
  self: 'self',
  'claude-code': 'claude-code',
  claudecode: 'claude-code',
  cc: 'claude-code',
  codex: 'codex',
  cdx: 'codex',
};

export interface DelegationDecision {
  /** Whether this message should be delegated to an external agent. */
  delegate: boolean;
  /** Target agent when delegating. */
  agent: FeishuDelegateAgent;
  /** The task text to hand off (prefix stripped). */
  task: string;
  /** Why we decided to delegate ('prefix' | 'route' | 'none'). */
  reason: 'prefix' | 'route' | 'none';
}

export interface DelegatePrefixMatch {
  /** True iff a delegation prefix matched at the start of the input. */
  matched: boolean;
  /** Which agent the prefix selected. Only meaningful when matched=true. */
  agent: FeishuDelegateAgent;
  /** The remaining task text with the prefix stripped. */
  task: string;
}

/**
 * Strip a leading `@cc` / `@codex` (and aliases) delegation prefix.
 * Returns whether it matched, which agent it selected, and the remaining
 * task text.
 */
export function parseDelegatePrefix(text: string): DelegatePrefixMatch {
  const raw = text ?? '';
  const m = raw.match(DELEGATE_PREFIX_RE);
  if (!m) return { matched: false, agent: 'claude-code', task: raw.trim() };
  const agent: FeishuDelegateAgent = m.groups?.cdx ? 'codex' : 'claude-code';
  return { matched: true, agent, task: raw.slice(m[0].length).trim() };
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
    return {
      delegate: true,
      agent: prefix.agent,
      task: prefix.task,
      reason: 'prefix',
    };
  }
  if (defaultAgent === 'claude-code' || defaultAgent === 'codex') {
    return {
      delegate: true,
      agent: defaultAgent,
      task: (text ?? '').trim(),
      reason: 'route',
    };
  }
  return {
    delegate: false,
    agent: 'claude-code',
    task: (text ?? '').trim(),
    reason: 'none',
  };
}

/** Execution mode forwarded to the delegate tool's `mode` parameter. */
export type DelegateDirectiveMode = 'stream' | 'background';

/**
 * Build the message handed to Easy Code's agent loop so it is forced to
 * delegate via the `delegate_to_claude_code` tool with the correct `agent`
 * and `mode` arguments. The tool's streaming output then flows to the Feishu
 * card unchanged.
 *
 * Default mode is `'stream'` — explicit `@cc` / `@codex` prefix and
 * `/bind --agent` route triggers indicate the user wants to watch the agent
 * work in real time, not fire-and-forget. Background dispatch is reserved
 * for the AI's own judgement on natural-language requests.
 */
export function buildDelegateDirective(
  task: string,
  agent: FeishuDelegateAgent = 'claude-code',
  mode: DelegateDirectiveMode = 'stream',
): string {
  const label = agent === 'codex' ? 'Codex' : 'Claude Code';
  const modeHint =
    mode === 'stream'
      ? '同步流式执行（用户要看到全过程）'
      : '后台异步执行（完成后通知用户）';
  return [
    `【强制派发指令】用户要求将以下任务交给本机的 ${label} 执行（${modeHint}）。`,
    `你必须立即调用 delegate_to_claude_code 工具，参数：agent="${agent}"，mode="${mode}"，task 填写下面的完整原文。`,
    '不要自己动手处理这个任务，也不要追问，直接派发：',
    '',
    task,
  ].join('\n');
}

/**
 * Parse the optional `--agent <self|claude-code|codex>` flag (or `-a`,
 * `--agent=value`) out of a `/bind` command argument string. Returns the
 * recognized agent (if any) and the remaining tokens with the flag removed
 * (so the path argument can still be parsed). Unknown values are silently
 * ignored (the value token is still consumed, so it can't leak into the
 * path).
 */
export function parseBindAgentFlag(argString: string): {
  agent?: FeishuAgentTarget;
  rest: string;
} {
  const tokens = (argString ?? '').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let agent: FeishuAgentTarget | undefined;

  const recognize = (raw: string | undefined): FeishuAgentTarget | undefined => {
    const v = (raw ?? '').toLowerCase();
    return BIND_AGENT_ALIASES[v];
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--agent' || t === '-a') {
      const matched = recognize(tokens[i + 1]);
      i++; // always consume the value token, even if invalid
      if (matched) agent = matched;
      continue;
    }
    const inline = t.match(/^--agent=(\S+)$/i);
    if (inline) {
      const matched = recognize(inline[1]);
      if (matched) agent = matched;
      continue;
    }
    out.push(t);
  }
  return { agent, rest: out.join(' ') };
}

/** Human-readable label for a chat's default-agent setting. */
export function agentDisplayLabel(agent: FeishuAgentTarget | undefined): string {
  if (agent && agent !== 'self') return AGENT_LABELS[agent];
  return SELF_LABEL;
}
