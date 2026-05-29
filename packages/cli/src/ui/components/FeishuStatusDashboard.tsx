/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { t } from '../utils/i18n.js';

// ── 类型定义 ──────────────────────────────────────────────

export interface FeishuProjectRoute {
  projectRoot?: string;
  description?: string;
  model?: string;
  thinking?: {
    mode: 'on' | 'off' | 'auto';
    effort?: 'auto' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  };
}

export interface FeishuMessageLogEntry {
  chatId: string;
  text: string;
  /** 方向: 'in'=飞书→Agent, 'out'=Agent→飞书回复, 'tool'=工具调用 */
  direction: 'in' | 'out' | 'tool';
  timestamp: number;
}

export interface FeishuStatusDashboardProps {
  routes: Record<string, FeishuProjectRoute>;
  activeGroupChatId: string | null;
  groupLogs: Record<string, FeishuMessageLogEntry[]>;
  botName: string;
  platform: string;
  isConnected: boolean;
  terminalWidth: number;
}

// ── 辅助 ──────────────────────────────────────────────────

/** 截断聊天 ID，取后 8 位便于阅读 */
function shortChatId(id: string): string {
  return id.length > 12 ? `...${id.slice(-8)}` : id;
}

/** 从路径取最后两级目录名 */
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2
    ? `.../${parts.slice(-2).join('/')}`
    : p;
}

/** 格式化时间戳 (HH:MM:SS) */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

/** 方向图标 */
function directionIcon(dir: 'in' | 'out' | 'tool'): string {
  switch (dir) {
    case 'in': return '◀';
    case 'out': return '▶';
    case 'tool': return '🔧';
  }
}

// ── 组件 ──────────────────────────────────────────────────

const MAX_VISIBLE_LOG_LINES = 5; // 可见窗口行数

export const FeishuStatusDashboard: React.FC<FeishuStatusDashboardProps> = ({
  routes,
  activeGroupChatId,
  groupLogs,
  botName,
  platform,
  isConnected,
  terminalWidth,
}) => {
  const routeEntries = Object.entries(routes);

  // ── 活动聊天的最新日志 (最多 MAX_VISIBLE_LOG_LINES 条) ──
  const activeLogs: FeishuMessageLogEntry[] = activeGroupChatId
    ? (groupLogs[activeGroupChatId] ?? []).slice(-MAX_VISIBLE_LOG_LINES)
    : [];

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.AccentBlue}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      flexDirection="column"
      width={Math.min(terminalWidth - 2, 100)}
    >
      {/* ── 顶部状态栏 ── */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color={Colors.AccentCyan}>
          {platform === 'lark' ? '🌐 Lark Bot' : '🌐 飞书 Bot'}
        </Text>
        <Text>
          {isConnected ? (
            <Text color={Colors.AccentGreen}>● {t('feishu.dashboard.connected')}</Text>
          ) : (
            <Text color={Colors.AccentRed}>● {t('feishu.dashboard.disconnected')}</Text>
          )}
        </Text>
      </Box>

      <Box>
        <Text dimColor>
          {t('feishu.dashboard.bot_name')}: {botName || t('feishu.start.bot_unknown')}
        </Text>
      </Box>

      {/* ── 分隔线 ── */}
      <Box marginY={1}>
        <Text color={Colors.Gray} dimColor>
          {'─'.repeat(Math.min(terminalWidth - 6, 96))}
        </Text>
      </Box>

      {/* ── 绑定项目列表 ── */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={Colors.AccentYellow}>
          {t('feishu.dashboard.bound_projects')} ({routeEntries.length})
        </Text>

        {routeEntries.length === 0 ? (
          <Box marginLeft={1} marginTop={1}>
            <Text dimColor>{t('feishu.dashboard.no_projects')}</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={0}>
            {routeEntries.map(([chatId, route]) => {
              const isActive = chatId === activeGroupChatId;
              // 屏幕足够宽时（>= 85 字符），显示完整的 chatId，否则使用短 chatId 截断，保证不换行
              const isWide = terminalWidth >= 85;
              const chatIdToShow = isWide ? chatId : shortChatId(chatId);
              return (
                <Box key={chatId} justifyContent="space-between" marginTop={0}>
                  <Box>
                    {isActive ? (
                      <Text color={Colors.AccentGreen} bold>
                        🟢 {chatIdToShow} <Text color={Colors.AccentGreen} dimColor>({t('feishu.dashboard.active').replace('🟢 ', '')})</Text>
                      </Text>
                    ) : (
                      <Text dimColor>
                        {'   '}{chatIdToShow}
                      </Text>
                    )}
                  </Box>
                  {route.projectRoot ? (
                    <Text color={isActive ? Colors.AccentGreen : Colors.Gray} dimColor={!isActive}>
                      📂 {shortPath(route.projectRoot)}
                    </Text>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* ── 活跃群的消息滚动窗口 ── */}
      {activeGroupChatId && activeLogs.length > 0 ? (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          paddingY={0}
          borderStyle="single"
          borderColor={Colors.Gray}
          borderDimColor={true}
        >
          <Box marginBottom={0}>
            <Text bold color={Colors.AccentCyan}>
              {t('feishu.dashboard.message_log')}
            </Text>
          </Box>
          {/* 用固定高度的滚动窗口展示最近消息 */}
          <Box flexDirection="column" minHeight={MAX_VISIBLE_LOG_LINES + 1}>
            {activeLogs.map((entry, i) => {
              const time = fmtTime(entry.timestamp);
              const icon = directionIcon(entry.direction);
              const displayText = entry.text.length > terminalWidth - 24
                ? entry.text.slice(0, terminalWidth - 27) + '...'
                : entry.text;
              return (
                <Box key={i} flexDirection="row">
                  <Text dimColor>{time}</Text>
                  <Text>{' '}</Text>
                  <Text
                    color={
                      entry.direction === 'in'
                        ? Colors.AccentGreen
                        : entry.direction === 'out'
                          ? Colors.AccentBlue
                          : Colors.AccentYellow
                    }
                  >
                    {icon}
                  </Text>
                  <Text>{' '}</Text>
                  <Text wrap="truncate">{displayText}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : activeGroupChatId ? (
        <Box marginTop={1} marginLeft={1}>
          <Text dimColor>{t('feishu.dashboard.waiting')}</Text>
        </Box>
      ) : routeEntries.length > 0 ? (
        <Box marginTop={1} marginLeft={1}>
          <Text dimColor>{t('feishu.dashboard.idle')}</Text>
        </Box>
      ) : null}

      {/* ── 底部提示 ── */}
      <Box marginTop={1}>
        <Text dimColor>
          {t('feishu.dashboard.hint_stop')}
        </Text>
      </Box>
    </Box>
  );
};
