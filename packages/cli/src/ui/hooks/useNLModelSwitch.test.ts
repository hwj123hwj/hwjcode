/**
 * useNLModelSwitch 测试
 */

import { describe, it, expect } from 'vitest';
import { detectNLModelSwitch } from '../hooks/useNLModelSwitch.js';
import { ModelInfo } from '../../utils/modelUtils.js';

const mockModels: ModelInfo[] = [
  { name: 'glm-5.1', displayName: 'GLM-5.1 (智谱)', creditsPerRequest: 5, available: true, maxToken: 128000, highVolumeThreshold: 64000, highVolumeCredits: 10 },
  { name: 'deepseek-v4-flash', displayName: 'DeepSeek-V4-Flash', creditsPerRequest: 2, available: true, maxToken: 128000, highVolumeThreshold: 64000, highVolumeCredits: 4 },
  { name: 'deepseek-v4-pro', displayName: 'DeepSeek-V4-Pro', creditsPerRequest: 6, available: true, maxToken: 128000, highVolumeThreshold: 64000, highVolumeCredits: 12 },
  { name: 'gemini-2.5-flash', displayName: 'Gemini-2.5-Flash', creditsPerRequest: 1, available: true, maxToken: 1000000, highVolumeThreshold: 500000, highVolumeCredits: 2 },
  { name: 'auto', displayName: 'Auto', creditsPerRequest: 0, available: true, maxToken: 0, highVolumeThreshold: 0, highVolumeCredits: 0 },
];

describe('detectNLModelSwitch', () => {
  it('匹配 "切换模型" + displayName', () => {
    const result = detectNLModelSwitch('切换模型DeepSeek-V4-Flash', mockModels);
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('deepseek-v4-flash');
  });

  it('匹配 "用" + 中文别名', () => {
    const result = detectNLModelSwitch('用智谱', mockModels);
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('glm-5.1');
  });

  it('匹配 "切换到" + 模型名', () => {
    const result = detectNLModelSwitch('切换到gemini', mockModels);
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('gemini-2.5-flash');
    expect(result!.matchedKeyword).toBe('切换到');
  });

  it('匹配 "换" + 模型名', () => {
    const result = detectNLModelSwitch('换deepseek-v4-pro', mockModels);
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('deepseek-v4-pro');
  });

  it('匹配 "切到" + 模型名', () => {
    const result = detectNLModelSwitch('切到deepseek', mockModels);
    expect(result).not.toBeNull();
    // deepseek 可能匹配多个，返回第一个
    expect(result!.modelName).toMatch(/deepseek/);
  });

  it('不匹配普通对话', () => {
    const result = detectNLModelSwitch('帮我写一个React组件', mockModels);
    expect(result).toBeNull();
  });

  it('不匹配斜杠命令', () => {
    const result = detectNLModelSwitch('/model glm-5.1', mockModels);
    expect(result).toBeNull();
  });

  it('不匹配空输入', () => {
    const result = detectNLModelSwitch('', mockModels);
    expect(result).toBeNull();
  });

  it('不匹配仅有关键词无模型名', () => {
    const result = detectNLModelSwitch('切换模型', mockModels);
    expect(result).toBeNull();
  });
});
