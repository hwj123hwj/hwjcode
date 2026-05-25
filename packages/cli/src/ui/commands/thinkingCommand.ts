/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, CommandContext, SlashCommand, SlashCommandActionReturn } from './types.js';
import { t, tp } from '../utils/i18n.js';
import { extractProvider, ThinkingConfig } from 'deepv-code-core';
import { SettingScope } from '../../config/settings.js';

/**
 * 思考模式及强度调控命令
 *
 * 功能：
 * - /thinking: 显示当前状态及帮助
 * - /thinking on: 开启思考模式
 * - /thinking off: 关闭思考模式
 * - /thinking auto: 设为自动（由模型/提供商默认决定）
 * - /thinking low: 设置低强度思考 (effort = 'low')
 * - /thinking medium: 设置中强度思考 (effort = 'medium')
 * - /thinking high: 设置高强度思考 (effort = 'high')
 * - /thinking max: 设置最大强度思考 (effort = 'max')
 * - /thinking status: 查看当前配置及生效情况
 */
export const thinkingCommand: SlashCommand = {
  name: 'thinking',
  description: t('command.thinking.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, args: string): Promise<SlashCommandActionReturn> => {
    const { config } = context.services;
    const trimmedArgs = args.trim().toLowerCase();

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('thinking.error.config.unavailable'),
      };
    }

    const currentModelId = config.getModel();
    const provider = extractProvider(currentModelId);

    // 获取当前思考配置
    const currentConfig: ThinkingConfig = config.getThinkingConfig() || { mode: 'auto', effort: 'auto' };

    const getModeLabel = (mode: string) => {
      switch (mode) {
        case 'on': return t('thinking.mode.on');
        case 'off': return t('thinking.mode.off');
        case 'auto':
        default: return t('thinking.mode.auto');
      }
    };

    const getEffortLabel = (effort: string | undefined) => {
      switch (effort) {
        case 'low': return t('thinking.effort.low');
        case 'medium': return t('thinking.effort.medium');
        case 'high': return t('thinking.effort.high');
        case 'max': return t('thinking.effort.max');
        case 'auto':
        default: return t('thinking.effort.auto');
      }
    };

    // 无参数或 status: 显示当前状态和帮助
    if (!trimmedArgs || trimmedArgs === 'status') {
      const modeLabel = getModeLabel(currentConfig.mode);
      const effortLabel = getEffortLabel(currentConfig.effort);

      let providerNote = '';
      if (provider) {
        if (provider === 'openai') {
          providerNote = `\n⚠️  ${t('thinking.provider.openai.warning')}`;
        } else if (provider === 'anthropic') {
          providerNote = `\n✅  ${t('thinking.provider.anthropic.ok')}`;
        } else if (provider === 'openai-responses') {
          providerNote = `\n✅  ${t('thinking.provider.openaiResponses.ok')}`;
        }
      }

      return {
        type: 'message',
        messageType: 'info',
        content: `💭 ${tp('thinking.status.current', { mode: modeLabel, effort: effortLabel })}${providerNote}

${t('thinking.usage.title')}
  /thinking off            - ${t('thinking.usage.off')}
  /thinking auto           - ${t('thinking.usage.auto')}
  /thinking low|medium|high|max - ${t('thinking.usage.effort')}
  /thinking status         - ${t('thinking.usage.status')}`,
      };
    }

    const updateConfig = async (newMode: 'on' | 'off' | 'auto', newEffort?: ThinkingConfig['effort']): Promise<SlashCommandActionReturn> => {
      try {
        const updated: ThinkingConfig = {
          mode: newMode,
          effort: newEffort ?? currentConfig.effort ?? 'auto',
          ...(currentConfig.budgetTokens !== undefined ? { budgetTokens: currentConfig.budgetTokens } : {}),
        };

        const { settings } = context.services;

        // 1. 运行时会话级覆盖 (内存中立即生效)
        config.setThinkingConfig(updated);

        // 2. 持久化到用户全局 settings.json (~/.deepv/settings.json)
        settings.setValue(SettingScope.User, 'thinking', updated);

        const modeLabel = getModeLabel(newMode);
        const effortLabel = getEffortLabel(updated.effort);

        return {
          type: 'message',
          messageType: 'info',
          content: `✨ ${tp('thinking.switched.success', { mode: modeLabel, effort: effortLabel })}`,
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: `❌ ${t('thinking.error.switch.failed')}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };

    // 1. 处理开关和强度指令
    if (trimmedArgs === 'on') {
      // 🆕 极简高级设计：/thinking on 默认重定向为高深度开启（effort: 'high'）
      return updateConfig('on', 'high');
    }
    if (trimmedArgs === 'off') {
      return updateConfig('off');
    }
    if (trimmedArgs === 'auto') {
      return updateConfig('auto');
    }

    // 2. 处理强度指令
    const efforts: Array<ThinkingConfig['effort']> = ['low', 'medium', 'high', 'max', 'auto'];
    if (efforts.includes(trimmedArgs as any)) {
      // 切换强度时，自动把模式设定为 "on" (除非原来是 auto 保持 auto)
      const targetMode = currentConfig.mode === 'auto' ? 'auto' : 'on';
      return updateConfig(targetMode, trimmedArgs as ThinkingConfig['effort']);
    }

    // 未知参数
    return {
      type: 'message',
      messageType: 'error',
      content: t('thinking.usage.error'),
    };
  },

  completion: async (_context, partialArg) => {
    // 🆕 极简高级设计：Tab 补全中隐藏单纯的 'on'，引导用户选择具体强度级别
    const commands = ['off', 'auto', 'low', 'medium', 'high', 'max', 'status'];
    return commands.filter((cmd) => cmd.startsWith(partialArg.toLowerCase()));
  },
};
