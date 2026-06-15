/**
 * 自然语言模型切换关键词匹配
 * 用户输入 "切换模型xxx" / "用xxx" / "换xxx" 等，直接匹配并切换，不发给AI
 * 模型从用户的 favoriteModels 收藏列表中匹配，不做全量模糊搜索
 */

/**
 * 收藏模型条目（精简版，只需 name + displayName）
 */
export interface FavoriteModelEntry {
  name: string;
  displayName: string;
}

/**
 * 模型切换触发关键词
 */
const SWITCH_KEYWORDS = [
  '切换模型', '切换为', '切换到', '切到', '换成', '换为', '换到',
  '切换至', '换成模型', '用模型', '使用模型', '用', '换', '切',
];

/**
 * 匹配结果
 */
export interface NLModelMatch {
  /** 匹配到的模型 internal name */
  modelName: string;
  /** 模型显示名 */
  modelDisplayName: string;
  /** 用户输入中匹配到的模型关键词 */
  matchedKeyword: string;
}

/**
 * 检查用户输入是否为自然语言模型切换命令
 * @returns 匹配结果，如果不是则返回 null
 */
export function detectNLModelSwitch(
  input: string,
  favorites: FavoriteModelEntry[],
): NLModelMatch | null {
  if (!input || !favorites.length) return null;

  const trimmed = input.trim();
  if (trimmed.length < 2) return null;

  // 排除斜杠命令
  if (trimmed.startsWith('/')) return null;

  // 1. 检测是否包含触发关键词
  let matchedKeyword = '';
  let remainingText = '';

  for (const kw of SWITCH_KEYWORDS) {
    // 匹配行首关键词
    if (trimmed.startsWith(kw)) {
      matchedKeyword = kw;
      remainingText = trimmed.slice(kw.length).trim();
      break;
    }
    // 匹配中间关键词（如 "帮我切换模型xxx"）
    const idx = trimmed.indexOf(kw);
    if (idx > 0 && idx + kw.length < trimmed.length) {
      matchedKeyword = kw;
      remainingText = trimmed.slice(idx + kw.length).trim();
      break;
    }
  }

  if (!matchedKeyword || !remainingText) return null;

  // 去掉常见噪音词，让"切换智谱模型" → modelQuery = "智谱"
  const NOISE_WORDS = ['模型', '的', '一下', '帮我', '给我', '现在', '然后', '那个', '这个'];
  let cleanText = remainingText;
  for (const noise of NOISE_WORDS) {
    cleanText = cleanText.replace(noise, '');
  }
  cleanText = cleanText.trim();
  if (!cleanText) return null;

  // 2. 在剩余文本中匹配模型名（仅收藏列表）
  const modelQuery = cleanText.toLowerCase();

  // 先精确匹配 model name
  for (const fav of favorites) {
    if (fav.name.toLowerCase() === modelQuery) {
      return {
        modelName: fav.name,
        modelDisplayName: fav.displayName || fav.name,
        matchedKeyword,
      };
    }
  }

  // 匹配 displayName
  for (const fav of favorites) {
    if (fav.displayName?.toLowerCase() === modelQuery) {
      return {
        modelName: fav.name,
        modelDisplayName: fav.displayName || fav.name,
        matchedKeyword,
      };
    }
  }

  // 模糊匹配：查询词拆成关键词，全部命中才匹配
  // "deepseek flash" → ["deepseek", "flash"] → 都包含在 "deepseek-v4-flash" 中 ✓
  const queryKeywords = modelQuery.split(/\s+/).filter((k: string) => k.length > 0);
  for (const fav of favorites) {
    const name = fav.name.toLowerCase();
    const display = (fav.displayName || '').toLowerCase();
    const combined = `${name} ${display}`;

    if (queryKeywords.every((kw: string) => combined.includes(kw))) {
      return {
        modelName: fav.name,
        modelDisplayName: fav.displayName || fav.name,
        matchedKeyword,
      };
    }
  }

  // 厂商别名匹配：用户说"智谱"但模型名是"glm-5.1"不含中文
  // "智谱" → glm, "深度求索" → deepseek, "谷歌/双子星" → gemini
  const VENDOR_ALIASES: Record<string, string> = {
    '智谱': 'glm',
    'zhipu': 'glm',
    'chatglm': 'glm',
    '深度求索': 'deepseek',
    'ds': 'deepseek',
    '双子星': 'gemini',
    '谷歌': 'gemini',
  };
  const vendorId = VENDOR_ALIASES[modelQuery];
  if (vendorId) {
    for (const fav of favorites) {
      if (fav.name.toLowerCase().startsWith(vendorId)) {
        return {
          modelName: fav.name,
          modelDisplayName: fav.displayName || fav.name,
          matchedKeyword,
        };
      }
    }
  }

  return null;
}

/**
 * 生成模型切换的确认消息
 */
export function buildSwitchMessage(
  modelDisplayName: string,
  matchedKeyword: string,
): string {
  return `🔄 已切换模型为：${modelDisplayName}`;
}
