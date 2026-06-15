import { describe, it, expect } from 'vitest';
import { detectNLCommand } from './useNLCommandDispatch.js';

describe('detectNLCommand', () => {
  // === 新开对话 ===
  describe('新开对话 → /new', () => {
    const cases = ['新对话', '开个新对话', '换个话题', '清空对话', '开始新对话', '重新开始', '新建对话', '开新对话'];
    for (const input of cases) {
      it(`"${input}" → /new`, () => {
        const result = detectNLCommand(input);
        expect(result).not.toBeNull();
        expect(result!.slashCommand).toBe('/new');
      });
    }

    it('带噪音词: "帮我新开一个对话" → 不匹配（完整关键词不在其中）', () => {
      // "帮我新开一个对话" 中去掉 "帮我" 后为 "新开一个对话"，不包含任何关键词
      const result = detectNLCommand('帮我新开一个对话');
      expect(result).toBeNull();
    });

    it('带噪音词但包含完整关键词: "帮我新对话" → /new', () => {
      // "帮我新对话" 去掉 "帮我" 后为 "新对话"，startsWith 匹配
      const result = detectNLCommand('帮我新对话');
      expect(result).not.toBeNull();
      expect(result!.slashCommand).toBe('/new');
    });
  });

  // === 压缩上下文 ===
  describe('压缩上下文 → /compress', () => {
    const cases = ['压缩上下文', '压缩对话', '压缩一下', '缩小上下文', '精简对话', '总结对话', '压缩下上下文'];
    for (const input of cases) {
      it(`"${input}" → /compress`, () => {
        const result = detectNLCommand(input);
        expect(result).not.toBeNull();
        expect(result!.slashCommand).toBe('/compress');
      });
    }

    it('带噪音词: "帮我压缩上下文" → /compress', () => {
      const result = detectNLCommand('帮我压缩上下文');
      expect(result).not.toBeNull();
      expect(result!.slashCommand).toBe('/compress');
    });
  });

  // === 知识库摄取 ===
  describe('知识库摄取 → /wiki ingest .', () => {
    const cases = ['整理知识库', '更新知识库', '知识库集取', '摄取文档到知识库', '知识库更新', '知识库摄取'];
    for (const input of cases) {
      it(`"${input}" → /wiki ingest .`, () => {
        const result = detectNLCommand(input);
        expect(result).not.toBeNull();
        expect(result!.slashCommand).toBe('/wiki ingest .');
      });
    }

    it('带噪音词: "帮我更新知识库" → /wiki ingest .', () => {
      const result = detectNLCommand('帮我更新知识库');
      expect(result).not.toBeNull();
      expect(result!.slashCommand).toBe('/wiki ingest .');
    });
  });

  // === 非命令输入（不应匹配） ===
  describe('非命令输入 → null', () => {
    const negativeCases = [
      '', // 空输入
      '写一个React组件', // 普通对话
      '新', // 太短不匹配
      '/new', // 斜杠命令，不走 NL dispatch
      '/compress', // 斜杠命令
      '/wiki ingest .', // 斜杠命令
      '？', // 太短
    ];
    for (const input of negativeCases) {
      it(`"${input}" → null`, () => {
        const result = detectNLCommand(input);
        expect(result).toBeNull();
      });
    }
  });

  // === 匹配优先级（新对话关键词在前，应优先命中） ===
  describe('优先级', () => {
    it('“精简对话”不应误匹配为新对话（不是以新开头）', () => {
      const result = detectNLCommand('精简对话');
      expect(result).not.toBeNull();
      expect(result!.slashCommand).toBe('/compress');
    });
  });
});
