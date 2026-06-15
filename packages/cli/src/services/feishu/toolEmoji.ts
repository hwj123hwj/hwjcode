/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 工具 → 语义 emoji（飞书卡片用）。
 *
 * 统一三处「当前工具」前缀：此前 Delegate / 子代理卡片用写死的沙漏 ⏳、会话列表
 * 用扳手 🔧，彼此不一致且没有信息量。改为按工具类型显示语义图标。
 *
 * 取值优先级：
 *   1) ACP `ToolKind`（Delegate 链路的权威分类，见 acpAgentClient 的 currentToolKind）；
 *   2) 工具 id / 短名 / 自由标题首词（子代理与会话卡片只有名字、没有 kind）。
 * 两者都命不中时兜底 🔧。
 *
 * 纯函数、无运行时依赖，便于单测，且可被 ui 层与 services 层共同复用。
 */

/** 命不中时的兜底图标。 */
export const FALLBACK_TOOL_EMOJI = '🔧';

/**
 * ACP `ToolKind` → emoji。与 acpAgentClient 的 transcript 调色板
 * （TOOL_KIND_DISPLAY）保持一致，避免同一次会话里 transcript 与结构化字段图标打架。
 */
const KIND_EMOJI: Record<string, string> = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '📦',
  search: '🔍',
  execute: '⚡',
  think: '💭',
  fetch: '🌐',
  switch_mode: '🔄',
  other: FALLBACK_TOOL_EMOJI,
};

/**
 * 工具 id / 短名 / 自由标题首词（统一小写）→ emoji。
 *
 * 覆盖内置工具的规范 id、feishuGetToolShortName 的短名（小写形式），以及外部
 * Agent 常见工具标题的首词（"Bash"/"Edit"/"Read"…）。
 */
const NAME_EMOJI: Record<string, string> = {
  // 执行 / shell
  run_shell_command: '⚡', bash: '⚡', shell: '⚡', terminal: '⚡', exec: '⚡',
  // 读
  read_file: '📖', read_many_files: '📖', readfile: '📖', readmanyfiles: '📖',
  read: '📖', cat: '📖', view: '📖',
  // 写 / 编辑
  write_file: '📝', writefile: '📝', write: '📝', create: '📝',
  replace: '✏️', multiedit: '✏️', edit: '✏️', update: '✏️', modify: '✏️',
  patch: '🩹',
  // 删 / 移
  delete_file: '🗑️', deletefile: '🗑️', delete: '🗑️', remove: '🗑️', rm: '🗑️',
  move: '📦', rename: '📦',
  // 搜索
  glob: '🔍', grep: '🔍', search_file_content: '🔍', searchcontent: '🔍',
  codesearch: '🔍', search: '🔍', find: '🔍',
  // 网络
  web_search: '🌐', websearch: '🌐', web_fetch: '🌐', webfetch: '🌐', fetch: '🌐',
  // 计划 / 思考
  todo_write: '📋', todowrite: '📋', think: '💭',
  // 委派 / 子代理 / 技能
  task: '🤖', subagenttask: '🤖',
  delegate_to_agent: '🤝', delegateagent: '🤝',
  use_skill: '🧩', useskill: '🧩',
  // 其它内置
  lsp: '🧭', batch: '📦',
};

/** 从自由标题（如 "Bash: npm test" / "Edit src/foo.ts"）取归一化首词。 */
function leadingToken(name: string): string {
  const first = name.trim().split(/[\s:(/\\.,]+/)[0] ?? '';
  return first.toLowerCase();
}

/**
 * 解析工具的语义 emoji。
 *
 * @param opts.kind ACP ToolKind（若有，优先采用）
 * @param opts.name 工具 id / 短名 / 自由标题（kind 命不中时回退）
 */
export function feishuToolEmoji(opts: { kind?: string; name?: string }): string {
  const kind = opts.kind?.trim().toLowerCase();
  if (kind && KIND_EMOJI[kind]) return KIND_EMOJI[kind];

  const name = opts.name?.trim();
  if (name) {
    const lower = name.toLowerCase();
    // 整名精确命中（工具 id 或短名）
    if (NAME_EMOJI[lower]) return NAME_EMOJI[lower];
    // 自由标题：取首词再试
    const lead = leadingToken(name);
    if (lead && NAME_EMOJI[lead]) return NAME_EMOJI[lead];
  }
  return FALLBACK_TOOL_EMOJI;
}
