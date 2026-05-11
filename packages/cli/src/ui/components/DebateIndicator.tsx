/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { getActiveDebate, ActiveDebate } from '../utils/debateState.js';

/**
 * 🎭 辩论模式指示器
 *
 * 常驻在输入框上方，显示当前发言模型 + 总进度。
 *
 * 为什么需要这个组件：
 * 之前在切换模型时通过 addItem 往历史里打 "✓ 已切换到 xxx"，但在 React 18 的
 * 自动批处理 + Ink 的增量渲染下，这条提示会有概率被紧接着的流式响应覆盖/吞掉。
 *
 * 解决方案：把 "当前谁在发言" 提升为一个**常驻 UI 状态**，而不是 "瞬时消息"。
 * 用户任何时候抬头都能看到当前发言方，不依赖某一条 addItem 是否被成功渲染。
 *
 * 实现细节：
 * - debateState 是模块级单例，不走 React，所以需要用 setInterval 轮询同步到
 *   组件 state 里触发重渲染。200ms 的刷新间隔对终端 UI 完全够用，开销可忽略。
 * - 非辩论状态 / 辩论已结束 时返回 null，不占用任何空间。
 */
export const DebateIndicator: React.FC = () => {
  const [debate, setDebate] = useState<ActiveDebate | null>(getActiveDebate());

  useEffect(() => {
    const timer = setInterval(() => {
      const current = getActiveDebate();
      setDebate((prev) => {
        // 浅比较：只在关键字段变化时更新，避免无谓重渲染
        if (!prev && !current) return prev;
        if (!prev || !current) return current;
        if (
          prev.status === current.status &&
          prev.cursor.round === current.cursor.round &&
          prev.cursor.modelIdx === current.cursor.modelIdx
        ) {
          return prev;
        }
        return { ...current };
      });
    }, 200);
    return () => clearInterval(timer);
  }, []);

  if (!debate || debate.status === 'done') return null;

  const currentModel = debate.models[debate.cursor.modelIdx] ?? '(unknown)';
  const totalTurns = debate.models.length * debate.rounds;
  const doneTurns =
    debate.cursor.round * debate.models.length + debate.cursor.modelIdx + 1;

  const statusColor =
    debate.status === 'paused' ? Colors.AccentYellow : Colors.AccentCyan;
  const statusLabel = debate.status === 'paused' ? '已暂停' : '进行中';

  return (
    <Box
      borderStyle="round"
      borderColor={statusColor}
      paddingX={1}
      marginBottom={0}
    >
      <Text color={statusColor} bold>
        🎭 辩论{statusLabel}
      </Text>
      <Text color={Colors.Gray}> │ </Text>
      <Text>当前发言：</Text>
      <Text color={Colors.AccentYellow} bold>
        {currentModel}
      </Text>
      <Text color={Colors.Gray}> │ </Text>
      <Text>进度：</Text>
      <Text color={Colors.AccentGreen} bold>
        {doneTurns}/{totalTurns}
      </Text>
      <Text color={Colors.Gray}> 轮</Text>
    </Box>
  );
};
