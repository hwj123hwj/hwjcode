/**
 * useNLModelSwitch 测试 —— 仅收藏列表匹配
 */

import { describe, it, expect } from 'vitest';
import { detectNLModelSwitch, FavoriteModelEntry } from '../hooks/useNLModelSwitch.js';

// 模拟收藏列表（用户已添加3个常用模型）
const mockFavorites: FavoriteModelEntry[] = [
  { name: 'glm-5.1', displayName: 'GLM-5.1 (智谱)' },
  { name: 'deepseek-v4-flash', displayName: 'DeepSeek-V4-Flash' },
  { name: 'gemini-2.5-flash', displayName: 'Gemini-2.5-Flash' },
];

describe('detectNLModelSwitch（收藏列表模式）', () => {
  it('匹配 "切换模型" + displayName', () => {
    const result = detectNLModelSwitch('切换模型DeepSeek-V4-Flash', mockFavorites);
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('deepseek-v4-flash');
  });

  it('匹配 "用" + 中文别名（displayName 含中文）', () => {
    const result = detectNLModelSwitch('用智谱', mockFavorites);
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('glm-5.1');
  });

  it('匹配 "切换到" + 模型名', () => {
    const result = detectNLModelSwitch('切换到gemini', mockFavorites);
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('gemini-2.5-flash');
    expect(result!.matchedKeyword).toBe('切换到');
  });

  it('匹配 "换" + 模型名', () => {
    const result = detectNLModelSwitch('换deepseek-v4-flash', mockFavorites);
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('deepseek-v4-flash');
  });

  it('匹配 "切到" + 模糊关键词', () => {
    const result = detectNLModelSwitch('切到deepseek', mockFavorites);
    expect(result).not.toBeNull();
    // 收藏列表只有一个 deepseek，精准命中
    expect(result!.modelName).toBe('deepseek-v4-flash');
  });

  it('不匹配未收藏的模型（deepseek-v4-pro没有收藏）', () => {
    const result = detectNLModelSwitch('换deepseek-v4-pro', mockFavorites);
    // 收藏列表没有 pro，只能模糊匹配到 flash
    expect(result).toBeNull();
  });

  it('不匹配普通对话', () => {
    const result = detectNLModelSwitch('帮我写一个React组件', mockFavorites);
    expect(result).toBeNull();
  });

  it('不匹配斜杠命令', () => {
    const result = detectNLModelSwitch('/model glm-5.1', mockFavorites);
    expect(result).toBeNull();
  });

  it('不匹配空输入', () => {
    const result = detectNLModelSwitch('', mockFavorites);
    expect(result).toBeNull();
  });

  it('不匹配仅有关键词无模型名', () => {
    const result = detectNLModelSwitch('切换模型', mockFavorites);
    expect(result).toBeNull();
  });

  it('空收藏列表不匹配', () => {
    const result = detectNLModelSwitch('用智谱', []);
    expect(result).toBeNull();
  });
});
