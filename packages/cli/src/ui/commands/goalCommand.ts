/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * /goal — 目标驱动模式（Goal-Driven Mode）
 *
 * 用户运行 `/goal` 后打开 GoalWizard 多步表单，收集：
 *   1. 任务描述
 *   2. 禁止事项
 *   3. 达标特征
 *   4. 最低持续工作小时数
 *   5. 强度档位（平稳 / 标准 / 高强度）
 *   6. prompt 预览确认
 *
 * 确认后由 useGoalWizard 完成：
 *   - 自动开启 YOLO 模式（如果未开启）
 *   - 拼装 prompt（包含让模型自己调用 local_time 取起始时间的指令）
 *   - 调用 submitQuery 提交给大模型
 *
 * 设计要点：仅返回 'dialog' action；真正的 prompt 提交逻辑放在 useGoalWizard.handleComplete，
 * 因为只有那里能闭包访问到 submitQuery。这与 debateCommand 的做法一致。
 */

import {
  CommandContext,
  CommandKind,
  MessageActionReturn,
  OpenDialogActionReturn,
  SlashCommand,
} from './types.js';
import { t } from '../utils/i18n.js';

const rootAction = async (
  context: CommandContext,
): Promise<MessageActionReturn | OpenDialogActionReturn> => {
  const { config } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('goalCommand.config_not_ready'),
    };
  }

  return {
    type: 'dialog',
    dialog: 'goal-wizard',
  };
};

export const goalCommand: SlashCommand = {
  name: 'goal',
  description: t('goalCommand.description'),
  kind: CommandKind.BUILT_IN,
  action: rootAction,
};
