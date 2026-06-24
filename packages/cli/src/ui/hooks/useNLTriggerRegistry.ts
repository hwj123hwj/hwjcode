/**
 * 自然语言触发注册中心（NL Trigger Registry）
 *
 * 统一管理所有 NL 触发规则：模型切换、命令调度、工具开关等。
 * 所有关键词、噪声词、匹配逻辑集中在一处，CLI 和 Feishu 共用。
 *
 * 设计原则：
 * - 规则按优先级排列，命中即返回（不再继续匹配）
 * - 统一噪声词列表，所有规则共享
 * - 规则类型分为三类：modelSwitch / command / toolToggle
 * - 模型切换需要额外参数（favorites），通过 context 传入
 */

// ============================================================
// 类型定义
// ============================================================

/**
 * 触发规则类型
 */
export type NLTriggerType = 'modelSwitch' | 'command' | 'toolToggle';

/**
 * 触发匹配结果
 */
export interface NLTriggerResult {
  /** 规则类型 */
  type: NLTriggerType;
  /** 命中时匹配到的关键词 */
  matchedKeyword: string;

  // --- modelSwitch 专属字段 ---
  /** 匹配到的模型 internal name（仅 type=modelSwitch） */
  modelName?: string;
  /** 模型显示名（仅 type=modelSwitch） */
  modelDisplayName?: string;
  /** 匹配到的模型是否为自定义模型（仅 type=modelSwitch） */
  isCustom?: boolean;

  // --- command / toolToggle 专属字段 ---
  /** 对应的 slash 命令字符串（仅 type=command 或 toolToggle） */
  slashCommand?: string;
}

/**
 * 模型切换匹配上下文（需要收藏列表）
 */
export interface ModelSwitchContext {
  /** 用户收藏模型列表 */
  favorites: FavoriteModelEntry[];
}

/**
 * 收藏模型条目
 */
export interface FavoriteModelEntry {
  name: string;
  displayName: string;
  /** 是否为自定义模型（通过本地网关等自定义接入的模型） */
  isCustom?: boolean;
}

/**
 * 触发规则基类
 */
interface NLTriggerRuleBase {
  /** 规则类型 */
  type: NLTriggerType;
  /** 优先级：数字越小优先级越高 */
  priority: number;
  /** 触发关键词列表 */
  keywords: string[];
}

/**
 * 模型切换规则
 */
interface ModelSwitchRule extends NLTriggerRuleBase {
  type: 'modelSwitch';
  /** 厂商别名映射 */
  vendorAliases?: Record<string, string>;
}

/**
 * 命令调度规则
 */
interface CommandRule extends NLTriggerRuleBase {
  type: 'command';
  /** 对应的 slash 命令 */
  slashCommand: string;
}

/**
 * 工具开关规则
 */
interface ToolToggleRule extends NLTriggerRuleBase {
  type: 'toolToggle';
  /** 工具名 */
  toolName: string;
  /** 开启触发词 */
  enableKeywords: string[];
  /** 关闭触发词 */
  disableKeywords: string[];
  /** 对应的 slash 命令（enable） */
  enableSlashCommand: string;
  /** 对应的 slash 命令（disable） */
  disableSlashCommand: string;
}

type NLTriggerRule = ModelSwitchRule | CommandRule | ToolToggleRule;

// ============================================================
// 统一噪声词
// ============================================================

/**
 * 统一噪声词列表（合并原 useNLModelSwitch 和 useNLCommandDispatch 的噪声词）
 * 去重后共 12 个
 */
const NOISE_WORDS = [
  '模型', '的', '一下', '帮我', '给我', '帮忙', '现在', '然后', '那个', '这个', '请', '麻烦',
  '换', '切换', '切换至', '换为', '换到',
];

/**
 * 从自定义模型 ID 中提取实际的 modelId
 * 格式: custom:{provider}:{modelId}@{hash}
 * 例如: custom:openai:glm-5.2@abc123 → glm-5.2
 */
function extractCustomModelId(fullId: string): string {
  const withoutPrefix = fullId.replace(/^custom:/, '');
  // split on first ':' to get provider, then rest is modelId@hash
  const colonIdx = withoutPrefix.indexOf(':');
  if (colonIdx < 0) return fullId;
  const modelPart = withoutPrefix.slice(colonIdx + 1);
  // strip the @hash suffix
  const atIdx = modelPart.lastIndexOf('@');
  return atIdx > 0 ? modelPart.slice(0, atIdx) : modelPart;
}

function stripNoise(input: string): string {
  let clean = input;
  // 去除中英文标点符号（用户输入常带句号、感叹号等）
  clean = clean.replace(/[。，！？.,!?；;：:、~～\s]+$/g, '');
  for (const noise of NOISE_WORDS) {
    clean = clean.replace(noise, '');
  }
  // 去标点后可能暴露的尾部空格再 trim 一次
  return clean.trim();
}

/**
 * 检测并移除"自定义"修饰词
 * @returns { customOnly: boolean, cleaned: string }
 */
function extractCustomModifier(input: string): { customOnly: boolean; cleaned: string } {
  const CUSTOM_KEYWORDS = ['自定义的', '自定义'];
  for (const kw of CUSTOM_KEYWORDS) {
    if (input.includes(kw)) {
      return { customOnly: true, cleaned: input.replace(kw, '').trim() };
    }
  }
  return { customOnly: false, cleaned: input };
}

// ============================================================
// 规则注册表（按优先级排列）
// ============================================================

/**
 * 所有 NL 触发规则，按优先级从小到大排列。
 * 命中即返回，不再继续匹配更低优先级的规则。
 *
 * 优先级设计：
 * - 模型切换优先级最高（1），因为 "切换模型xxx" 是明确的意图
 * - 命令调度次之（2-10），按使用频率排列
 * - 工具开关最低（11+），因为工具开关词较短，容易误匹配
 */
const NL_TRIGGER_RULES: NLTriggerRule[] = [
  // ── 模型切换 ──
  {
    type: 'modelSwitch',
    priority: 1,
    keywords: [
      '切换模型', '切换为', '切换到', '切换至', '切换', '切到',
      '换成', '换为', '换到', '换成模型', '用模型', '使用模型', '用', '换', '切',
    ],
    vendorAliases: {
      '智谱': 'glm',
      'zhipu': 'glm',
      'chatglm': 'glm',
      '深度求索': 'deepseek',
      'ds': 'deepseek',
      '双子星': 'gemini',
      '谷歌': 'gemini',
      '小米': 'mimo',
      'xiaomi': 'mimo',
    },
  },

  // ── 命令调度：新开对话 ──
  {
    type: 'command',
    priority: 2,
    keywords: [
      '新对话', '开个新对话', '换个话题', '清空对话',
      '开始新对话', '重新开始', '新建对话', '开新对话',
    ],
    slashCommand: '/new',
  },

  // ── 命令调度：压缩上下文 ──
  {
    type: 'command',
    priority: 3,
    keywords: [
      '压缩上下文', '压缩对话', '压缩一下', '缩小上下文',
      '精简对话', '总结对话', '压缩下上下文',
    ],
    slashCommand: '/compress',
  },

  // ── 命令调度：知识库摄取 ──
  {
    type: 'command',
    priority: 4,
    keywords: [
      '整理知识库', '更新知识库', '知识库集取',
      '摄取文档到知识库', '知识库更新', '知识库摄取',
    ],
    slashCommand: '/wiki ingest .',
  },

  // ── 工具开关：生图 ──
  {
    type: 'toolToggle',
    priority: 11,
    keywords: ['开启生图', '打开生图', '启用生图', '关闭生图', '停用生图', '禁用生图'],
    toolName: 'nanobanana_generate',
    enableKeywords: ['开启生图', '打开生图', '启用生图'],
    disableKeywords: ['关闭生图', '停用生图', '禁用生图'],
    enableSlashCommand: '/tool enable nanobanana_generate',
    disableSlashCommand: '/tool disable nanobanana_generate',
  },

  // ── 工具开关：音频 ──
  {
    type: 'toolToggle',
    priority: 12,
    keywords: ['开启音频', '打开音频', '启用音频', '关闭音频', '停用音频', '禁用音频'],
    toolName: 'audio_reader',
    enableKeywords: ['开启音频', '打开音频', '启用音频'],
    disableKeywords: ['关闭音频', '停用音频', '禁用音频'],
    enableSlashCommand: '/tool enable audio_reader',
    disableSlashCommand: '/tool disable audio_reader',
  },
];

// ============================================================
// 匹配管线
// ============================================================

/**
 * 在文本中尝试匹配关键词
 * 匹配策略：行首匹配优先，中间匹配兜底
 */
function findKeywordMatch(text: string, keywords: string[]): string | null {
  // 行首匹配优先
  for (const kw of keywords) {
    if (text.startsWith(kw)) return kw;
  }
  // 中间匹配兜底
  for (const kw of keywords) {
    const idx = text.indexOf(kw);
    if (idx > 0) return kw;
  }
  return null;
}

/**
 * 模型名匹配（5 层策略 + 自定义模型支持）
 *
 * 匹配策略（按顺序）：
 * 1. 精确匹配 model name（含自定义模型实际 modelId）
 * 2. 精确匹配 displayName
 * 3. 拆词模糊匹配
 * 4. 厂商别名匹配
 * 5. 前缀匹配
 *
 * 自定义模型支持：
 * - 当 customOnly=true 时，仅匹配 isCustom 的收藏
 * - 当 customOnly=false（默认）时，优先匹配非自定义模型；
 *   若非自定义无匹配但自定义有匹配，则返回自定义模型
 * - 自定义模型 ID 中的实际 modelId（从 custom:{provider}:{modelId}@{hash} 提取）也参与匹配
 */
function matchModelName(
  query: string,
  favorites: FavoriteModelEntry[],
  vendorAliases?: Record<string, string>,
  customOnly?: boolean,
): { modelName: string; modelDisplayName: string; isCustom?: boolean } | null {
  const q = query.toLowerCase();

  // 按 customOnly 过滤候选列表
  const candidates = customOnly
    ? favorites.filter(f => f.isCustom)
    : favorites;

  // 辅助：构建结果
  const toResult = (fav: FavoriteModelEntry) => ({
    modelName: fav.name,
    modelDisplayName: fav.displayName || fav.name,
    isCustom: fav.isCustom || false,
  });

  // 1. 精确匹配 model name
  for (const fav of candidates) {
    if (fav.name.toLowerCase() === q) return toResult(fav);
  }
  // 自定义模型：也用提取出的实际 modelId 匹配
  if (!customOnly) {
    for (const fav of favorites.filter(f => f.isCustom)) {
      const actualId = extractCustomModelId(fav.name);
      if (actualId.toLowerCase() === q) return toResult(fav);
    }
  }

  // 2. 精确匹配 displayName
  for (const fav of candidates) {
    if (fav.displayName?.toLowerCase() === q) return toResult(fav);
  }

  // 3. 拆词模糊匹配：查询词拆成关键词，全部命中才匹配
  const queryKeywords = q.split(/\s+/).filter(k => k.length > 0);
  for (const fav of candidates) {
    const name = fav.name.toLowerCase();
    const display = (fav.displayName || '').toLowerCase();
    const combined = `${name} ${display}`;
    if (queryKeywords.every(kw => combined.includes(kw))) return toResult(fav);
  }
  // 自定义模型：也用提取出的实际 modelId 参与匹配
  if (!customOnly) {
    for (const fav of favorites.filter(f => f.isCustom)) {
      const actualId = extractCustomModelId(fav.name).toLowerCase();
      const display = (fav.displayName || '').toLowerCase();
      const combined = `${actualId} ${display}`;
      if (queryKeywords.every(kw => combined.includes(kw))) return toResult(fav);
    }
  }

  // 4. 厂商别名匹配
  if (vendorAliases) {
    const vendorId = vendorAliases[q];
    if (vendorId) {
      for (const fav of candidates) {
        const nameLower = fav.name.toLowerCase();
        const actualId = fav.isCustom ? extractCustomModelId(fav.name).toLowerCase() : nameLower;
        if (nameLower.startsWith(vendorId) || actualId.startsWith(vendorId)) {
          return toResult(fav);
        }
      }
    }
  }

  // 5. 前缀匹配（如用户说 "gemini" 可匹配 "gemini-2.5-flash"）
  if (!customOnly) {
    for (const fav of candidates) {
      const nameLower = fav.name.toLowerCase();
      if (nameLower.startsWith(q)) return toResult(fav);
    }
  }

  return null;
}

/**
 * 统一 NL 触发检测入口
 *
 * 匹配管线：
 * 1. 排除斜杠命令和空输入
 * 2. 按优先级遍历规则
 * 3. 模型切换规则：关键词匹配 → 剩余文本去噪 → 模型名匹配
 * 4. 命令调度规则：原样匹配 → 去噪后再匹配
 * 5. 工具开关规则：精确匹配 enable/disable 关键词
 *
 * @param input 用户原始输入
 * @param context 可选上下文（模型切换需要 favorites）
 * @returns 匹配结果，未命中返回 null
 */
export function detectNLTrigger(
  input: string,
  context?: ModelSwitchContext,
): NLTriggerResult | null {
  if (!input) return null;

  const trimmed = input.trim();
  if (trimmed.length < 2) return null;

  // 排除斜杠命令
  if (trimmed.startsWith('/') || trimmed.startsWith('?')) return null;

  // 按优先级遍历规则
  for (const rule of NL_TRIGGER_RULES) {
    switch (rule.type) {
      case 'modelSwitch': {
        // 模型切换需要 favorites 上下文
        if (!context?.favorites?.length) continue;

        // 模型切换的关键词匹配需要提取 remaining text，
        // 不能用通用 findKeywordMatch（它只返回关键词，不返回位置）
        let matchedKw = '';
        let remaining = '';

        for (const kw of rule.keywords) {
          // 行首匹配优先
          if (trimmed.startsWith(kw)) {
            matchedKw = kw;
            remaining = trimmed.slice(kw.length).trim();
            break;
          }
          // 中间匹配兜底（如 "帮我切换模型xxx"）
          const idx = trimmed.indexOf(kw);
          if (idx > 0 && idx + kw.length < trimmed.length) {
            matchedKw = kw;
            remaining = trimmed.slice(idx + kw.length).trim();
            break;
          }
        }

        if (!matchedKw || !remaining) continue;

        // 检测"自定义"修饰词（如"切换自定义智谱" → customOnly=true, cleaned="智谱"）
        const { customOnly, cleaned: remainingAfterCustom } = extractCustomModifier(remaining);

        // 去噪
        const cleanRemaining = stripNoise(remainingAfterCustom);
        if (!cleanRemaining) continue;

        // 模型名匹配
        const modelMatch = matchModelName(cleanRemaining, context.favorites, rule.vendorAliases, customOnly);
        if (modelMatch) {
          return {
            type: 'modelSwitch',
            matchedKeyword: matchedKw,
            modelName: modelMatch.modelName,
            modelDisplayName: modelMatch.modelDisplayName,
            isCustom: modelMatch.isCustom,
          };
        }
        // 模型切换关键词命中但模型名未匹配 → 不继续匹配其他规则
        // 因为用户意图明确是切换模型，不应被误匹配为其他命令
        return null;
      }

      case 'command': {
        // 第一遍：原样匹配
        const rawKw = findKeywordMatch(trimmed, rule.keywords);
        if (rawKw) {
          return {
            type: 'command',
            matchedKeyword: rawKw,
            slashCommand: rule.slashCommand,
          };
        }

        // 第二遍：去噪后匹配
        const cleanInput = stripNoise(trimmed);
        if (cleanInput !== trimmed) {
          const cleanKw = findKeywordMatch(cleanInput, rule.keywords);
          if (cleanKw) {
            return {
              type: 'command',
              matchedKeyword: cleanKw,
              slashCommand: rule.slashCommand,
            };
          }
        }
        break;
      }

      case 'toolToggle': {
        // 工具开关用精确匹配（不做去噪，因为触发词本身很短）
        if (rule.enableKeywords.includes(trimmed)) {
          return {
            type: 'toolToggle',
            matchedKeyword: trimmed,
            slashCommand: rule.enableSlashCommand,
          };
        }
        if (rule.disableKeywords.includes(trimmed)) {
          return {
            type: 'toolToggle',
            matchedKeyword: trimmed,
            slashCommand: rule.disableSlashCommand,
          };
        }
        break;
      }
    }
  }

  return null;
}

// ============================================================
// 辅助导出（供外部使用）
// ============================================================

/**
 * 生成模型切换的确认消息
 */
export function buildSwitchMessage(modelDisplayName: string, matchedKeyword: string): string {
  return `🔄 已切换模型为：${modelDisplayName}`;
}

/**
 * 获取所有工具开关规则（供 feishuCommand 的 /tool 命令使用）
 */
export function getToolToggleRules(): ToolToggleRule[] {
  return NL_TRIGGER_RULES.filter(r => r.type === 'toolToggle') as ToolToggleRule[];
}

/**
 * 获取统一噪声词列表（供测试或调试使用）
 */
export function getNoiseWords(): string[] {
  return [...NOISE_WORDS];
}
