/**
 * 自然语言命令关键词匹配
 * 用户输入 "新对话" / "压缩上下文" / "整理知识库" 等自然语言，自动映射到对应 slash 命令
 * 在 slash 命令检测和模型切换检测之后执行，命中则构造 slash 命令走统一的命令管线
 */

/**
 * 命令匹配器：关键词集合 → slash 命令
 */
interface CommandMatcher {
  /** 触发关键词列表 */
  keywords: string[];
  /** 对应的 slash 命令（如 "/new", "/compress", "/wiki ingest ."） */
  slashCommand: string;
}

/**
 * 匹配结果
 */
export interface NLCommandMatch {
  /** 对应的 slash 命令字符串 */
  slashCommand: string;
  /** 命中时匹配到的关键词 */
  matchedKeyword: string;
}

/**
 * 命令匹配器配置
 * 按优先级排列：越靠前的匹配器优先级越高
 */
const COMMAND_MATCHERS: CommandMatcher[] = [
  // --- 新开对话 ---
  {
    keywords: [
      '新对话',
      '开个新对话',
      '换个话题',
      '清空对话',
      '开始新对话',
      '重新开始',
      '新建对话',
      '开新对话',
    ],
    slashCommand: '/new',
  },
  // --- 压缩上下文 ---
  {
    keywords: [
      '压缩上下文',
      '压缩对话',
      '压缩一下',
      '缩小上下文',
      '精简对话',
      '总结对话',
      '压缩下上下文',
    ],
    slashCommand: '/compress',
  },
  // --- 知识库摄取 ---
  {
    keywords: [
      '整理知识库',
      '更新知识库',
      '知识库集取',
      '摄取文档到知识库',
      '知识库更新',
      '知识库摄取',
    ],
    slashCommand: '/wiki ingest .',
  },
];

/**
 * 去除常见噪音词，提取核心意图
 */
const NOISE_WORDS = ['帮我', '给我', '帮忙', '一下', '现在', '请', '麻烦'];

function stripNoise(input: string): string {
  let clean = input;
  for (const noise of NOISE_WORDS) {
    clean = clean.replace(noise, '');
  }
  return clean.trim();
}

/**
 * 检测用户输入是否为自然语言命令
 *
 * 匹配规则：
 * 1. 输入以关键词开头（行首匹配）
 * 2. 输入中包含关键词（中间匹配，如 "帮我新开一个对话"）
 *
 * 排除：斜杠命令、空输入
 *
 * @param input 用户原始输入
 * @returns 匹配结果，如果不是命令则返回 null
 */
/**
 * 在给定文本中尝试匹配命令关键词
 */
function tryMatch(text: string): NLCommandMatch | null {
  for (const matcher of COMMAND_MATCHERS) {
    for (const kw of matcher.keywords) {
      // 行首匹配
      if (text.startsWith(kw)) {
        return { slashCommand: matcher.slashCommand, matchedKeyword: kw };
      }
      // 中间匹配（如 "帮我新开一个对话"、去噪音后 "新对话" 出现在中间）
      const idx = text.indexOf(kw);
      if (idx > 0) {
        return { slashCommand: matcher.slashCommand, matchedKeyword: kw };
      }
    }
  }
  return null;
}

export function detectNLCommand(input: string): NLCommandMatch | null {
  if (!input) return null;

  const trimmed = input.trim();
  if (trimmed.length < 2) return null;

  // 排除斜杠命令
  if (trimmed.startsWith('/') || trimmed.startsWith('?')) return null;

  // 第一遍：原样匹配（保留完整自然表达，如 "压缩一下"）
  const rawMatch = tryMatch(trimmed);
  if (rawMatch) return rawMatch;

  // 第二遍：去噪音后匹配（如 "帮我新对话" → "新对话"）
  const cleanInput = stripNoise(trimmed);
  if (cleanInput !== trimmed) {
    return tryMatch(cleanInput);
  }

  return null;
}
