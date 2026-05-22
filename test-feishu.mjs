/**
 * 快速测试 /feishu 命令
 * 用法: node test-feishu.mjs
 */
import { feishuCommand } from './packages/cli/dist/src/ui/commands/feishuCommand.js';

async function main() {
  const args = process.argv.slice(2).join(' ');

  console.log(`\n🔧 Testing /feishu ${args}\n`);

  // 模拟 CommandContext
  const ctx = {
    invocation: { raw: `/feishu ${args}`, name: 'feishu', args },
    services: { config: null, settings: {}, git: undefined, logger: console },
    isNonInteractive: true,
    ui: {
      addItem: () => 0,
      clear: () => {},
      setDebugMessage: () => {},
      pendingItem: null,
      setPendingItem: () => {},
      loadHistory: () => {},
      toggleCorgiMode: () => {},
      toggleVimEnabled: async () => false,
      debugMessages: [],
    },
    session: {
      stats: {
        sessionStartTime: new Date(),
        metrics: { models: {}, tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, totalDurationMs: 0, totalDecisions: { accept: 0, reject: 0, modify: 0 }, byName: {} } },
        lastPromptTokenCount: 0,
        promptCount: 0,
        subAgentStats: { totalApiCalls: 0, totalErrors: 0, totalLatencyMs: 0, totalTokens: 0, promptTokens: 0, candidatesTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, thoughtsTokens: 0, toolTokens: 0 },
      },
      cumulativeCredits: 0,
      totalSessionCredits: 0,
      lastTokenUsage: null,
    },
  };

  const result = await feishuCommand.action(ctx, args);
  if (result && 'type' in result) {
    console.log(result.content);
    console.log();
  }
}

main().catch(console.error);
