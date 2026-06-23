/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `create_remote_session` 工具：仅在 `--cloud-mode` 远程会话中专属挂载。
 *
 * 用户在任意会话里用自然语言说“拉个新 session，物理路径是 D:\\projects\\xxx”时，
 * Agent 思考后会调用本工具。工具会：
 *   1. 确保目标物理路径存在（不存在则递归创建）；
 *   2. 反向调用 RemoteServer.createNewSessionForPath，创建一个绑定该工作目录、
 *      Config / ToolRegistry / GeminiClient 完全物理隔离的新会话；
 *   3. 通过 WebSocket 主动向控制端推送 `switch_to_session_notification`，
 *      通知前端（Web/App）自动切换 / 跳转到新会话窗口；
 *   4. 把成功描述返回给 LLM。
 *
 * 拆成独立模块（而非内联在 remoteSession.ts）以便用 mock 依赖做单测。
 */

import { Type } from '@google/genai';
import { BaseTool, Icon, type ToolResult } from 'deepv-code-core';

export interface CreateRemoteSessionParams {
  /** 新会话绑定的物理绝对路径，例如 D:\\projects\\another-project */
  project_path: string;
}

export interface CreateRemoteSessionToolDeps {
  /**
   * 反向调用服务端创建一个绑定指定工作目录的隔离新会话，返回新 sessionId。
   * 由 RemoteSession 包装为 `(p) => remoteServer.createNewSessionForPath(p)`。
   */
  createSessionForPath: (projectPath: string) => Promise<string>;
  /**
   * 向当前控制端推送切换会话通知。由 RemoteSession 包装为通过自身 ws 发送
   * `switch_to_session_notification` 消息。
   */
  notifySwitch: (newSessionId: string, projectPath: string) => void;
  /**
   * 可注入的文件系统（便于测试）。默认使用 node:fs。仅用到这两个方法。
   */
  fs?: {
    existsSync(p: string): boolean;
    mkdirSync(p: string, opts: { recursive: boolean }): unknown;
  };
}

const TOOL_DESCRIPTION = [
  'Creates a brand-new, fully isolated remote session bound to a specific physical working directory,',
  'then notifies the controlling Web/App client to switch to it.',
  'Use this tool when the user wants to start working in a DIFFERENT project directory within the',
  'current cloud-mode connection — e.g. "拉个新 session，物理路径是 D:\\projects\\another-project",',
  '"open a new session for /home/me/other-repo", "新建一个会话切到 D:\\work\\demo".',
  'The new session gets its own Config / ToolRegistry / GeminiClient, so it runs in parallel and never',
  'pollutes the current session. If the directory does not exist it will be created recursively.',
  'Only available in remote cloud-mode sessions.',
].join(' ');

export class CreateRemoteSessionTool extends BaseTool<
  CreateRemoteSessionParams,
  ToolResult
> {
  static readonly Name = 'create_remote_session';

  constructor(private readonly deps: CreateRemoteSessionToolDeps) {
    super(
      CreateRemoteSessionTool.Name,
      'CreateRemoteSession',
      TOOL_DESCRIPTION,
      Icon.Folder,
      {
        type: Type.OBJECT,
        properties: {
          project_path: {
            type: Type.STRING,
            description:
              'The absolute physical path the new session should bind to, e.g. D:\\projects\\another-project or /home/me/repo.',
          },
        },
        required: ['project_path'],
      },
    );
  }

  validateToolParams(params: CreateRemoteSessionParams): string | null {
    if (!params?.project_path || typeof params.project_path !== 'string') {
      return 'Parameter "project_path" must be a non-empty string.';
    }
    if (!params.project_path.trim()) {
      return 'Parameter "project_path" must not be blank.';
    }
    return null;
  }

  async execute(
    params: CreateRemoteSessionParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: ${validationError}`,
        returnDisplay: `Error: ${validationError}`,
      };
    }

    try {
      const fs = this.deps.fs ?? (await import('node:fs'));
      const path = await import('node:path');

      // 1. 解析为绝对路径并确保目录存在（不存在则递归创建）。
      const absPath = path.resolve(params.project_path);
      if (!fs.existsSync(absPath)) {
        fs.mkdirSync(absPath, { recursive: true });
      }

      // 2. 反向调用服务端，创建绑定该路径的隔离新会话。
      const newSessionId = await this.deps.createSessionForPath(absPath);

      // 3. 主动通知控制端切换 / 跳转到新会话窗口。
      this.deps.notifySwitch(newSessionId, absPath);

      // 4. 返回成功描述给 LLM。
      return {
        llmContent:
          `Successfully created a new isolated remote session '${newSessionId}' bound to working directory '${absPath}'. ` +
          `The controlling client has been notified to switch to it. ` +
          `This new session is fully isolated (its own Config, ToolRegistry and model client) and runs in parallel with the current one.`,
        returnDisplay: `✅ Created new session \`${newSessionId}\` at \`${absPath}\` and switched the client to it.`,
      };
    } catch (e: any) {
      const msg = e?.message || String(e);
      return {
        llmContent: `Error creating remote session for '${params.project_path}': ${msg}`,
        returnDisplay: `Error: ${msg}`,
      };
    }
  }
}
