/**
 * 自然语言模型切换关键词匹配
 * 用户输入 "切换模型xxx" / "用xxx" / "换xxx" 等，直接匹配并切换，不发给AI
 */

import { ModelInfo } from '../../utils/modelUtils.js';

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
  availableModels: ModelInfo[],
): NLModelMatch | null {
  if (!input || !availableModels.length) return null;

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

  // 2. 在剩余文本中匹配模型名
  const modelQuery = remainingText.toLowerCase();

  // 先精确匹配 model name
  for (const model of availableModels) {
    if (model.name.toLowerCase() === modelQuery) {
      return {
        modelName: model.name,
        modelDisplayName: model.displayName || model.name,
        matchedKeyword,
      };
    }
  }

  // 匹配 displayName
  for (const model of availableModels) {
    if (model.displayName?.toLowerCase() === modelQuery) {
      return {
        modelName: model.name,
        modelDisplayName: model.displayName || model.name,
        matchedKeyword,
      };
    }
  }

  // 模糊匹配：关键词包含在模型名中
  const fuzzyMatches: NLModelMatch[] = [];
  for (const model of availableModels) {
    const name = model.name.toLowerCase();
    const display = (model.displayName || '').toLowerCase();

    // 模型名或显示名包含查询词
    if (name.includes(modelQuery) || display.includes(modelQuery)) {
      fuzzyMatches.push({
        modelName: model.name,
        modelDisplayName: model.displayName || model.name,
        matchedKeyword,
      });
    }
  }

  if (fuzzyMatches.length === 1) return fuzzyMatches[0];
  if (fuzzyMatches.length > 1) {
    // 多个匹配，返回第一个（这是模糊匹配的已知限制，用户需要更精确地输入）
    return fuzzyMatches[0];
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
