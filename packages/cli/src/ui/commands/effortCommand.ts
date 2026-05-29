/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandContext, SlashCommand, SlashCommandActionReturn, CommandKind } from './types.js';
import { SettingScope } from '../../config/settings.js';
import { t } from '../utils/i18n.js';

export const effortCommand: SlashCommand = {
  name: 'effort',
  altNames: ['\\effort'], // 支持反斜杠作为别名，以提高兼容性
  description: 'Adjust thinking effort depth and workflow orchestration',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const target = args ? args.trim().toLowerCase() : '';

    // 如果没有参数，则打开交互式 Effort Wizard 对话框
    if (target === '') {
      return {
        type: 'dialog',
        dialog: 'effort-wizard',
      };
    }

    const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto'];
    if (!validEfforts.includes(target)) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid effort level: "${args}". Valid values are: low, medium, high, xhigh, max, ultracode, auto.`,
      };
    }

    const { config, settings } = context.services;
    if (!config || !settings) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config or settings service is unavailable.',
      };
    }

    const currentConfig = config.getThinkingConfig() || { mode: 'auto', effort: 'auto' };
    const newMode: 'on' | 'auto' | 'off' = (target === 'auto') ? 'auto' : 'on';

    const updated = {
      mode: newMode,
      effort: target as any,
      ...(currentConfig.budgetTokens !== undefined ? { budgetTokens: currentConfig.budgetTokens } : {}),
    };

    config.setThinkingConfig(updated);
    settings.setValue(SettingScope.User, 'thinking', updated);

    let desc = '';
    switch (target) {
      case 'low':
        desc = 'low effort';
        break;
      case 'medium':
        desc = 'medium effort';
        break;
      case 'high':
        desc = 'high effort';
        break;
      case 'xhigh':
        desc = 'xhigh effort';
        break;
      case 'max':
        desc = 'max effort';
        break;
      case 'ultracode':
        desc = 'xhigh + dynamic workflow orchestration';
        break;
      default:
        desc = 'auto effort';
        break;
    }

    return {
      type: 'message',
      messageType: 'info',
      content: `Set effort level to ${target} (this session only): ${desc}`,
    };
  },
};
