/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';

export enum AppEvent {
  OpenDebugConsole = 'open-debug-console',
  LogError = 'log-error',
  FeishuServerStarted = 'feishu-server-started',
  FeishuServerStopped = 'feishu-server-stopped',
  FeishuBotStarted = 'feishu-bot-started',
  FeishuBotStopped = 'feishu-bot-stopped',
  FeishuBotProcessingStart = 'feishu-bot-processing-start',
  FeishuBotProcessingEnd = 'feishu-bot-processing-end',
  /** 飞书仪表板：指定群（chatId）开始处理消息 */
  FeishuGroupProcessingStart = 'feishu-group-processing-start',
  /** 飞书仪表板：指定群（chatId）处理完毕 */
  FeishuGroupProcessingEnd = 'feishu-group-processing-end',
  /** 飞书仪表板：实时消息日志（用于滚动窗口） */
  FeishuMessageLog = 'feishu-message-log',
  /** 飞书仪表板：项目路由表已更新 */
  FeishuProjectRoutesUpdated = 'feishu-project-routes-updated',
  AuthenticationSuccessful = 'authentication-successful',
  AuthenticationFailed = 'authentication-failed',
  AuthenticationRequired = 'authentication-required',
  UserLoggedOut = 'user-logged-out',
  TokensUpdated = 'tokens-updated',
  TokensCleared = 'tokens-cleared',
  ModelChanged = 'model-changed',
  CreditsConsumed = 'credits-consumed',
  ImagePollingStart = 'image-polling-start',
  ImagePollingProgress = 'image-polling-progress',
  ImagePollingEnd = 'image-polling-end',
  SelectionWarning = 'selection-warning',
  PasteTimeout = 'paste-timeout',
  Flicker = 'flicker',
  // Stream recovery events
  StreamRecoveryStart = 'stream-recovery-start',
  StreamRecoveryCountdown = 'stream-recovery-countdown',
  StreamRecoveryEnd = 'stream-recovery-end',
}

export const appEvents = new EventEmitter();
