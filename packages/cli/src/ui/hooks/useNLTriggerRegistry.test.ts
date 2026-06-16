/**
 * useNLTriggerRegistry 测试 —— 统一 NL 触发注册中心
 */

import { describe, it, expect } from 'vitest';
import {
  detectNLTrigger,
  buildSwitchMessage,
  getNoiseWords,
  FavoriteModelEntry,
  NLTriggerResult,
} from './useNLTriggerRegistry.js';

// 模拟收藏列表
const mockFavorites: FavoriteModelEntry[] = [
  { name: 'glm-5.1', displayName: 'GLM-5.1' },
  { name: 'deepseek-v4-flash', displayName: 'DeepSeek-V4-Flash' },
  { name: 'gemini-2.5-flash', displayName: 'Gemini-2.5-Flash' },
];

// ============================================================
// 模型切换
// ============================================================

describe('模型切换（type=modelSwitch）', () => {
  it('匹配 "切换模型" + displayName', () => {
    const result = detectNLTrigger('切换模型DeepSeek-V4-Flash', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('modelSwitch');
    expect(result!.modelName).toBe('deepseek-v4-flash');
  });

  it('匹配 "用" + 中文别名（厂商别名 → glm）', () => {
    const result = detectNLTrigger('用智谱', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('glm-5.1');
  });

  it('匹配 "切换到" + 模型名', () => {
    const result = detectNLTrigger('切换到gemini', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('gemini-2.5-flash');
    expect(result!.matchedKeyword).toBe('切换到');
  });

  it('匹配 "换" + 模型名', () => {
    const result = detectNLTrigger('换deepseek-v4-flash', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('deepseek-v4-flash');
  });

  it('匹配多关键词 "deepseek flash"', () => {
    const result = detectNLTrigger('用deepseek flash', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('deepseek-v4-flash');
  });

  it('匹配 "切到" + 模糊关键词', () => {
    const result = detectNLTrigger('切到deepseek', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('deepseek-v4-flash');
  });

  it('匹配 "切换智谱模型"（噪声词"模型"被过滤）', () => {
    const result = detectNLTrigger('切换智谱模型', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('glm-5.1');
  });

  it('匹配 "切换智谱的模型"（噪声词"的""模型"被过滤）', () => {
    const result = detectNLTrigger('切换智谱的模型', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('glm-5.1');
  });

  it('匹配 "用zhipu"（英文厂商别名 → glm）', () => {
    const result = detectNLTrigger('用zhipu', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('glm-5.1');
  });

  it('匹配 "用深度求索"（厂商别名 → deepseek）', () => {
    const result = detectNLTrigger('用深度求索', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('deepseek-v4-flash');
  });

  it('匹配 "用谷歌"（厂商别名 → gemini）', () => {
    const result = detectNLTrigger('用谷歌', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('gemini-2.5-flash');
  });

  it('匹配 "切双子星"（厂商别名 → gemini）', () => {
    const result = detectNLTrigger('切双子星', { favorites: mockFavorites });
    expect(result).not.toBeNull();
    expect(result!.modelName).toBe('gemini-2.5-flash');
  });

  // 不匹配场景
  it('不匹配未收藏的模型', () => {
    const result = detectNLTrigger('换deepseek-v4-pro', { favorites: mockFavorites });
    expect(result).toBeNull();
  });

  it('不匹配普通对话', () => {
    const result = detectNLTrigger('帮我写一个React组件', { favorites: mockFavorites });
    expect(result).toBeNull();
  });

  it('不匹配斜杠命令', () => {
    const result = detectNLTrigger('/model glm-5.1', { favorites: mockFavorites });
    expect(result).toBeNull();
  });

  it('不匹配空输入', () => {
    const result = detectNLTrigger('', { favorites: mockFavorites });
    expect(result).toBeNull();
  });

  it('不匹配仅有关键词无模型名', () => {
    const result = detectNLTrigger('切换模型', { favorites: mockFavorites });
    expect(result).toBeNull();
  });

  it('空收藏列表不匹配模型切换', () => {
    const result = detectNLTrigger('用智谱', { favorites: [] });
    expect(result).toBeNull();
  });

  it('无 context 不匹配模型切换', () => {
    const result = detectNLTrigger('用智谱');
    expect(result).toBeNull();
  });
});

// ============================================================
// 命令调度
// ============================================================

describe('命令调度（type=command）', () => {
  // 新开对话
  describe('新开对话 → /new', () => {
    const cases = ['新对话', '开个新对话', '换个话题', '清空对话', '开始新对话', '重新开始', '新建对话', '开新对话'];
    for (const input of cases) {
      it(`"${input}" → /new`, () => {
        const result = detectNLTrigger(input);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('command');
        expect(result!.slashCommand).toBe('/new');
      });
    }

    it('带噪声词: "帮我新对话" → /new', () => {
      const result = detectNLTrigger('帮我新对话');
      expect(result).not.toBeNull();
      expect(result!.slashCommand).toBe('/new');
    });
  });

  // 压缩上下文
  describe('压缩上下文 → /compress', () => {
    const cases = ['压缩上下文', '压缩对话', '压缩一下', '缩小上下文', '精简对话', '总结对话', '压缩下上下文'];
    for (const input of cases) {
      it(`"${input}" → /compress`, () => {
        const result = detectNLTrigger(input);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('command');
        expect(result!.slashCommand).toBe('/compress');
      });
    }

    it('带噪声词: "帮我压缩上下文" → /compress', () => {
      const result = detectNLTrigger('帮我压缩上下文');
      expect(result).not.toBeNull();
      expect(result!.slashCommand).toBe('/compress');
    });
  });

  // 知识库摄取
  describe('知识库摄取 → /wiki ingest .', () => {
    const cases = ['整理知识库', '更新知识库', '知识库集取', '摄取文档到知识库', '知识库更新', '知识库摄取'];
    for (const input of cases) {
      it(`"${input}" → /wiki ingest .`, () => {
        const result = detectNLTrigger(input);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('command');
        expect(result!.slashCommand).toBe('/wiki ingest .');
      });
    }

    it('带噪声词: "帮我更新知识库" → /wiki ingest .', () => {
      const result = detectNLTrigger('帮我更新知识库');
      expect(result).not.toBeNull();
      expect(result!.slashCommand).toBe('/wiki ingest .');
    });
  });
});

// ============================================================
// 工具开关
// ============================================================

describe('工具开关（type=toolToggle）', () => {
  it('开启生图 → /tool enable nanobanana_generate', () => {
    const result = detectNLTrigger('开启生图');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('toolToggle');
    expect(result!.slashCommand).toBe('/tool enable nanobanana_generate');
  });

  it('打开生图 → /tool enable nanobanana_generate', () => {
    const result = detectNLTrigger('打开生图');
    expect(result).not.toBeNull();
    expect(result!.slashCommand).toBe('/tool enable nanobanana_generate');
  });

  it('关闭生图 → /tool disable nanobanana_generate', () => {
    const result = detectNLTrigger('关闭生图');
    expect(result).not.toBeNull();
    expect(result!.slashCommand).toBe('/tool disable nanobanana_generate');
  });

  it('开启音频 → /tool enable audio_reader', () => {
    const result = detectNLTrigger('开启音频');
    expect(result).not.toBeNull();
    expect(result!.slashCommand).toBe('/tool enable audio_reader');
  });

  it('关闭音频 → /tool disable audio_reader', () => {
    const result = detectNLTrigger('关闭音频');
    expect(result).not.toBeNull();
    expect(result!.slashCommand).toBe('/tool disable audio_reader');
  });
});

// ============================================================
// 优先级
// ============================================================

describe('优先级：模型切换 > 命令调度 > 工具开关', () => {
  it('模型切换关键词命中但模型名未匹配 → 返回 null（不降级到命令调度）', () => {
    // "切换模型xxx" 命中了模型切换关键词，但 xxx 不在收藏列表中
    // 不应降级匹配为其他命令
    const result = detectNLTrigger('切换模型unknown', { favorites: mockFavorites });
    expect(result).toBeNull();
  });

  it('命令调度优先级高于工具开关', () => {
    // "新对话" 应匹配 /new，不应匹配工具开关
    const result = detectNLTrigger('新对话');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('command');
    expect(result!.slashCommand).toBe('/new');
  });
});

// ============================================================
// 非命令输入
// ============================================================

describe('非命令输入 → null', () => {
  const negativeCases = [
    '',
    '写一个React组件',
    '新',
    '/new',
    '/compress',
    '/wiki ingest .',
    '？',
  ];
  for (const input of negativeCases) {
    it(`"${input}" → null`, () => {
      const result = detectNLTrigger(input);
      expect(result).toBeNull();
    });
  }
});

// ============================================================
// 辅助函数
// ============================================================

describe('辅助函数', () => {
  it('buildSwitchMessage 生成确认消息', () => {
    const msg = buildSwitchMessage('GLM-5.1', '切换到');
    expect(msg).toBe('🔄 已切换模型为：GLM-5.1');
  });

  it('getNoiseWords 返回统一噪声词列表', () => {
    const words = getNoiseWords();
    expect(words).toContain('帮我');
    expect(words).toContain('模型');
    expect(words).toContain('请');
    expect(words).toContain('麻烦');
    expect(words.length).toBe(12);
  });
});
