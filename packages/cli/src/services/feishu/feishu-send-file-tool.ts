/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTool, ToolResult, Icon } from 'deepv-code-core';
import { Type } from '@google/genai';
import { FeishuGateway } from './gateway.js';

/**
 * Parameters for the send_feishu_file tool
 */
export interface SendFeishuFileParams {
  /**
   * Absolute path to the file to send
   */
  file_path: string;

  /**
   * The chat_id to send the file to.
   * If not provided, sends to the current active chat.
   */
  chat_id?: string;
}

/**
 * Dynamically registered tool: send_feishu_file
 *
 * Only registered when /feishu start runs, unregistered on /feishu stop.
 * This tool uploads a local file to Feishu and sends it as a file message.
 */
export class SendFeishuFileTool extends BaseTool<SendFeishuFileParams, ToolResult> {
  static readonly Name: string = 'send_feishu_file';

  constructor(
    private readonly gateway: FeishuGateway,
    private readonly getActiveChatId: () => string | undefined,
    private readonly getActiveReplyToMessageId: () => string | undefined,
  ) {
    super(
      SendFeishuFileTool.Name,
      'SendFeishuFile',
      `Sends a local file to the current Feishu chat. Uploads the file and sends it as a file message. Supports images (png, jpg, gif, webp, svg, bmp) and other files (pdf, txt, zip, etc.). You do NOT need to provide a chat_id — the file will be sent to the user's current chat automatically.`,
      Icon.Globe,
      {
        properties: {
          file_path: {
            description:
              "The absolute path to the file to send (e.g., '/home/user/project/report.pdf'). The file must exist on the local filesystem.",
            type: Type.STRING,
          },
        },
        required: ['file_path'],
        type: Type.OBJECT,
      },
    );
  }

  validateToolParams(params: SendFeishuFileParams): string | null {
    if (!params.file_path) {
      return 'file_path is required';
    }
    return null;
  }

  getDescription(params: SendFeishuFileParams): string {
    return `Sending file to Feishu: ${params.file_path}`;
  }

  async execute(
    params: SendFeishuFileParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const { file_path } = params;

    // Resolve chatId: explicit param > active chat
    const chatId = params.chat_id || this.getActiveChatId();
    if (!chatId) {
      return {
        llmContent: `Error: No active Feishu chat to send the file to. Make sure the Feishu bot is running and has received a message.`,
        returnDisplay: `Error: No active Feishu chat`,
      };
    }

    const replyToMessageId = this.getActiveReplyToMessageId();

    // Validate file exists
    const fs = await import('fs');
    if (!fs.existsSync(file_path)) {
      return {
        llmContent: `Error: File not found: ${file_path}`,
        returnDisplay: `Error: File not found: ${file_path}`,
      };
    }

    // Check if it's a file (not directory)
    const stat = fs.statSync(file_path);
    if (stat.isDirectory()) {
      return {
        llmContent: `Error: Path is a directory, not a file: ${file_path}`,
        returnDisplay: `Error: Path is a directory: ${file_path}`,
      };
    }

    const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
    const path = await import('path');
    const ext = path.extname(file_path).slice(1).toLowerCase();
    const isImage = IMAGE_EXTS.includes(ext);

    try {
      if (isImage) {
        const imageKey = await this.gateway.uploadImage(file_path);
        const msgId = await this.gateway.sendImage(chatId, imageKey, replyToMessageId);
        return {
          llmContent: `Successfully sent image to Feishu: ${file_path}${msgId ? ` (message_id: ${msgId})` : ''}`,
          returnDisplay: `Image sent: ${file_path}`,
        };
      } else {
        const fileKey = await this.gateway.uploadFile(file_path);
        const msgId = await this.gateway.sendFile(chatId, fileKey, replyToMessageId);
        return {
          llmContent: `Successfully sent file to Feishu: ${file_path}${msgId ? ` (message_id: ${msgId})` : ''}`,
          returnDisplay: `File sent: ${file_path}`,
        };
      }
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      return {
        llmContent: `Error sending file to Feishu: ${errorMsg}`,
        returnDisplay: `Error: ${errorMsg}`,
      };
    }
  }
}
