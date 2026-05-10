/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType as _AuthType,
  type Config,
  type GeminiChat,
  type ToolResult,
  type ToolCallConfirmationDetails,
  convertToFunctionResponse,
  logToolCall,
  isNodeError,
  isWithinRoot,
  getErrorMessage,
  getErrorStatus,
  MESSAGE_ROLES,
  SceneType,
  REFERENCE_CONTENT_START,
  REFERENCE_CONTENT_END,
  ToolConfirmationOutcome,
  coreEvents,
  CoreEvent,
} from 'deepv-code-core';
import * as acp from '@agentclientprotocol/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Content,
  type FunctionCall,
  type Part,
  type PartListUnion,
} from '@google/genai';
import type { LoadedSettings } from '../config/settings.js';
import {
  RequestPermissionResponseSchema,
  hasMeta,
  toToolCallContent,
  toPermissionOptions,
  toAcpToolKind,
} from './acpUtils.js';
import { getAcpErrorMessage } from './acpErrors.js';

/**
 * One live ACP chat session.
 *
 * Owns:
 *   - the backing `GeminiChat` (the LLM conversation)
 *   - an `AbortController` that ties a single prompt turn's lifetime together
 *   - forwarding of approval-mode events back to the IDE via `sessionUpdate`
 *
 * Lifecycle:
 *   `new Session(...)` → `.prompt(...)` many times → `.dispose()` (called by
 *   `AcpSessionManager` when the connection closes).
 */
export class Session {
  private pendingAbort?: AbortController;
  private readonly approvalModeUnsubscribe: () => void;

  constructor(
    readonly id: string,
    private readonly chat: GeminiChat,
    private readonly config: Config,
    private readonly connection: acp.AgentSideConnection,
    private readonly _settings: LoadedSettings,
  ) {
    this.approvalModeUnsubscribe = coreEvents.on(
      CoreEvent.ApprovalModeChanged,
      (payload) => {
        if (payload.sessionId && payload.sessionId !== this.id) return;
        void this.sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `[MODE_UPDATE] ${payload.mode}`,
          },
        });
      },
    );
  }

  dispose(): void {
    this.pendingAbort?.abort();
    this.pendingAbort = undefined;
    this.approvalModeUnsubscribe();
  }

  async cancelPendingPrompt(): Promise<void> {
    this.pendingAbort?.abort();
    this.pendingAbort = undefined;
  }

  setMode(modeId: string): void {
    // DeepCode's ApprovalMode uses upper-case ids; ACP clients send back the
    // same ids we advertised via `buildAvailableModes`, so we coerce in place
    // and let `Config.setApprovalMode` validate.
    const cfg = this.config as unknown as {
      setApprovalMode?: (mode: string) => void;
    };
    cfg.setApprovalMode?.(modeId);
  }

  setModel(modelId: string): void {
    const cfg = this.config as unknown as {
      setModel?: (modelId: string) => void;
    };
    cfg.setModel?.(modelId);
  }

  /**
   * Stream back previously-persisted messages so the IDE can rehydrate its
   * transcript view on `session/load`.
   */
  async streamHistory(messages: readonly unknown[]): Promise<void> {
    for (const raw of messages) {
      const msg = raw as {
        role?: string;
        parts?: Part[];
        content?: PartListUnion;
      };
      if (!msg) continue;
      const parts = Array.isArray(msg.parts)
        ? msg.parts
        : msg.content !== undefined
          ? ([] as Part[]).concat(
              typeof msg.content === 'string'
                ? [{ text: msg.content } as Part]
                : Array.isArray(msg.content)
                  ? (msg.content as Part[])
                  : [msg.content as Part],
            )
          : [];
      const text = parts
        .map((p) => (typeof (p as { text?: string }).text === 'string'
          ? (p as { text: string }).text
          : ''))
        .join('');
      if (!text) continue;
      await this.sendUpdate(
        msg.role === 'user'
          ? {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text },
            }
          : {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
      );
    }
  }

  /**
   * Emit the current list of slash commands to the IDE. DeepCode's ACP layer
   * only ships a minimal set of built-ins (`/help`, `/memory`, `/init`,
   * `/about`); the richer registry from gemini-cli can be plugged in via
   * `acpCommandHandler.ts`.
   */
  async sendAvailableCommands(): Promise<void> {
    // Discover commands via the CommandHandler if present; fall back to a
    // static list so the IDE UI is never empty.
    let commands: Array<{ name: string; description: string }> = [];
    try {
      const { CommandHandler } = await import('./acpCommandHandler.js');
      commands = new CommandHandler().getAvailableCommands();
    } catch {
      commands = [
        { name: 'help', description: 'List available commands' },
        { name: 'about', description: 'Show version / environment info' },
        { name: 'memory show', description: 'Show current memory' },
        { name: 'init', description: 'Generate a DEEPV.md for this project' },
      ];
    }
    await this.sendUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: commands.map((c) => ({
        name: c.name,
        description: c.description,
      })),
    });
  }

  /**
   * Main prompt turn. Consumes `GeminiChat.sendMessageStream`, relays chunks
   * as `session/update` notifications, and loops while the model issues
   * function calls.
   */
  async prompt(req: acp.PromptRequest): Promise<acp.PromptResponse> {
    // Intercept slash commands before touching the LLM.
    const textChunks = req.prompt
      .filter((c) => (c as { type?: string }).type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('')
      .trim();
    if (textChunks.startsWith('/') || textChunks.startsWith('$')) {
      try {
        const { CommandHandler } = await import('./acpCommandHandler.js');
        const handler = new CommandHandler();
        const handled = await handler.handleCommand(textChunks, {
          config: this.config,
          settings: this._settings,
          sendMessage: async (text) => {
            await this.sendUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            });
          },
        });
        if (handled) {
          return { stopReason: 'end_turn' };
        }
      } catch {
        // Fall through to LLM path if command handling fails entirely.
      }
    }

    this.pendingAbort?.abort();
    const abort = new AbortController();
    this.pendingAbort = abort;

    const promptId = Math.random().toString(16).slice(2);
    const parts = await this.resolvePrompt(req, abort.signal);

    let nextMessage: Content | null = {
      role: MESSAGE_ROLES.USER,
      parts,
    };

    try {
      while (nextMessage !== null) {
        if (abort.signal.aborted) {
          this.chat.addHistory(nextMessage);
          return { stopReason: 'cancelled' };
        }
        const functionCalls: FunctionCall[] = [];
        try {
          const toolRegistry = await this.config.getToolRegistry();
          const stream = await this.chat.sendMessageStream(
            {
              message: nextMessage.parts ?? [],
              config: {
                abortSignal: abort.signal,
                tools: [
                  {
                    functionDeclarations:
                      toolRegistry.getFunctionDeclarations(),
                  },
                ],
              },
            },
            promptId,
            SceneType.CHAT_CONVERSATION,
          );
          nextMessage = null;
          for await (const resp of stream) {
            if (abort.signal.aborted) return { stopReason: 'cancelled' };
            const candidate = resp.candidates?.[0];
            for (const part of candidate?.content?.parts ?? []) {
              if (!part.text) continue;
              await this.sendUpdate(
                part.thought
                  ? {
                      sessionUpdate: 'agent_thought_chunk',
                      content: { type: 'text', text: part.text },
                    }
                  : {
                      sessionUpdate: 'agent_message_chunk',
                      content: { type: 'text', text: part.text },
                    },
              );
            }
            if (resp.functionCalls) functionCalls.push(...resp.functionCalls);
          }
        } catch (err) {
          if (getErrorStatus(err) === 429) {
            throw new acp.RequestError(
              429,
              'Rate limit exceeded. Try again later.',
            );
          }
          throw err;
        }

        if (functionCalls.length > 0) {
          const responseParts: Part[] = [];
          for (const fc of functionCalls) {
            const resp = await this.runTool(abort.signal, promptId, fc);
            const arr = Array.isArray(resp) ? resp : [resp];
            for (const part of arr) {
              if (typeof part === 'string') responseParts.push({ text: part });
              else if (part) responseParts.push(part);
            }
          }
          nextMessage = { role: MESSAGE_ROLES.USER, parts: responseParts };
        }
      }
      return { stopReason: 'end_turn' };
    } finally {
      if (this.pendingAbort === abort) this.pendingAbort = undefined;
    }
  }

  // --- private helpers ------------------------------------------------------

  private async sendUpdate(update: acp.SessionUpdate): Promise<void> {
    try {
      await this.connection.sessionUpdate({
        sessionId: this.id,
        update,
      });
    } catch (err) {
      // A failed update must not crash the prompt loop.
      this.debug(`sessionUpdate failed: ${getAcpErrorMessage(err)}`);
    }
  }

  private async runTool(
    signal: AbortSignal,
    promptId: string,
    fc: FunctionCall,
  ): Promise<PartListUnion> {
    const callId = fc.id ?? `${fc.name ?? 'unknown'}-${Date.now()}`;
    const args = (fc.args ?? {}) as Record<string, unknown>;
    const startTime = Date.now();

    const errorResponse = (error: Error): PartListUnion => {
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        prompt_id: promptId,
        function_name: fc.name ?? '',
        function_args: args,
        duration_ms: Date.now() - startTime,
        success: false,
        error: error.message,
        response_length: error.message.length,
      });
      return [
        {
          functionResponse: {
            id: callId,
            name: fc.name ?? '',
            response: { error: error.message },
          },
        } as Part,
      ];
    };

    if (!fc.name) return errorResponse(new Error('Missing function name'));

    const toolRegistry = await this.config.getToolRegistry();
    const tool = toolRegistry.getTool(fc.name);
    if (!tool) {
      return errorResponse(
        new Error(`Tool "${fc.name}" not found in registry.`),
      );
    }

    const toolCallId = callId;
    const toolKind = toAcpToolKind(
      ((tool as unknown as { kind?: unknown }).kind as never) ??
        ('other' as never),
    );

    // Announce the tool call to the IDE.
    await this.sendUpdate({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: tool.getDescription?.(args) ?? fc.name,
      kind: toolKind,
      status: 'pending',
      locations: tool.toolLocations?.(args) ?? undefined,
    });

    // Confirm if necessary.
    const confirmation = await tool.shouldConfirmExecute(args, signal);
    if (confirmation) {
      const options = toPermissionOptions(confirmation, this.config);
      try {
        const rawResp = await this.connection.requestPermission({
          sessionId: this.id,
          toolCall: {
            toolCallId,
            title: tool.getDescription?.(args) ?? fc.name,
            kind: toolKind,
          },
          options,
        });
        const parsed = RequestPermissionResponseSchema.parse(rawResp);
        if (parsed.outcome.outcome === 'cancelled') {
          await this.sendUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
          });
          return errorResponse(
            new Error(`Tool "${fc.name}" was canceled by the user.`),
          );
        }
        const outcome = parsed.outcome.optionId as ToolConfirmationOutcome;
        if (outcome === ToolConfirmationOutcome.Cancel) {
          await confirmation.onConfirm(outcome);
          await this.sendUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
          });
          return errorResponse(
            new Error(`Tool "${fc.name}" not allowed to run by the user.`),
          );
        }
        await confirmation.onConfirm(outcome);
      } catch (err) {
        await this.sendUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
        });
        return errorResponse(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    // Execute.
    try {
      const result: ToolResult = await tool.execute(args, signal);
      const content = toToolCallContent(result);
      await this.sendUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: content ? [content] : undefined,
      });
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        prompt_id: promptId,
        function_name: fc.name,
        function_args: args,
        duration_ms: Date.now() - startTime,
        success: true,
        response_length:
          typeof result.llmContent === 'string'
            ? result.llmContent.length
            : JSON.stringify(result.llmContent ?? '').length,
      });
      return convertToFunctionResponse(fc.name, callId, result.llmContent);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.sendUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: error.message } },
        ],
      });
      return errorResponse(error);
    }
  }

  /**
   * Resolve `@path` references in the incoming prompt into real file content.
   *
   * Ported from the DeepCode legacy `acpPeer.ts#resolveUserMessage` — same
   * semantics, only the `ContentBlock` shape is adjusted for the new SDK.
   */
  private async resolvePrompt(
    req: acp.PromptRequest,
    signal: AbortSignal,
  ): Promise<Part[]> {
    const blocks = req.prompt;
    // New SDK exposes `resource_link { uri }` instead of the legacy `{ path }`.
    const atPathBlocks = blocks.filter((b) => {
      const type = (b as { type?: string }).type;
      return (
        type === 'resource_link' ||
        (b as { path?: unknown }).path !== undefined
      );
    });

    if (atPathBlocks.length === 0) {
      return blocks.flatMap((b) => {
        const type = (b as { type?: string }).type;
        if (type === 'text' || (b as { text?: unknown }).text !== undefined) {
          return [{ text: (b as { text: string }).text } as Part];
        }
        if (type === 'image') {
          const img = b as unknown as { mimeType?: string; data?: string };
          if (img.mimeType && img.data) {
            return [
              {
                inlineData: { mimeType: img.mimeType, data: img.data },
              } as Part,
            ];
          }
        }
        return [];
      });
    }

    const fileDiscovery = this.config.getFileService();
    const respectGitIgnore = this.config.getFileFilteringRespectGitIgnore();
    const pathSpecsToRead: string[] = [];
    const atPathToResolved = new Map<string, string>();
    const labels: string[] = [];
    const ignored: string[] = [];

    const toolRegistry = await this.config.getToolRegistry();
    const readManyFilesTool = toolRegistry.getTool('read_many_files');
    const globTool = toolRegistry.getTool('glob');
    if (!readManyFilesTool) {
      throw new Error('read_many_files tool not found.');
    }

    const extractPath = (b: unknown): string | undefined => {
      const x = b as { path?: string; uri?: string };
      if (typeof x.path === 'string') return x.path;
      if (typeof x.uri === 'string') {
        // strip a `file://` prefix if present.
        return x.uri.replace(/^file:\/\//, '');
      }
      return undefined;
    };

    for (const block of atPathBlocks) {
      const pathName = extractPath(block);
      if (!pathName) continue;

      if (fileDiscovery.shouldGitIgnoreFile(pathName)) {
        ignored.push(pathName);
        continue;
      }

      let currentPathSpec = pathName;
      let resolved = false;

      try {
        const absolute = path.resolve(this.config.getTargetDir(), pathName);
        if (isWithinRoot(absolute, this.config.getTargetDir())) {
          const stats = await fs.stat(absolute);
          if (stats.isDirectory()) {
            currentPathSpec = pathName.endsWith('/')
              ? `${pathName}**`
              : `${pathName}/**`;
          }
          resolved = true;
        }
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          if (this.config.getEnableRecursiveFileSearch() && globTool) {
            try {
              const globResult = await globTool.execute(
                { pattern: `**/*${pathName}*`, path: this.config.getTargetDir() },
                signal,
              );
              if (
                typeof globResult.llmContent === 'string' &&
                !globResult.llmContent.startsWith('No files found') &&
                !globResult.llmContent.startsWith('Error:')
              ) {
                const lines = globResult.llmContent.split('\n');
                if (lines.length > 1 && lines[1]) {
                  currentPathSpec = path.relative(
                    this.config.getTargetDir(),
                    lines[1].trim(),
                  );
                  resolved = true;
                }
              }
            } catch {
              // glob failed; path is skipped.
            }
          }
        }
      }

      if (resolved) {
        pathSpecsToRead.push(currentPathSpec);
        atPathToResolved.set(pathName, currentPathSpec);
        labels.push(pathName);
      }
    }

    // Re-assemble the query text, substituting resolved specs for @-paths.
    let queryText = '';
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if ((block as { text?: string }).text !== undefined) {
        queryText += (block as { text: string }).text;
        continue;
      }
      const raw = extractPath(block);
      if (!raw) continue;
      const resolvedSpec = atPathToResolved.get(raw);
      if (
        i > 0 &&
        queryText.length > 0 &&
        !queryText.endsWith(' ')
      ) {
        queryText += ' ';
      }
      queryText += `@${resolvedSpec ?? raw}`;
    }
    queryText = queryText.trim();

    if (ignored.length > 0) {
      this.debug(
        `Ignored ${ignored.length} path(s) (${respectGitIgnore ? 'git-ignored' : 'custom-ignored'}): ${ignored.join(', ')}`,
      );
    }

    if (pathSpecsToRead.length === 0) {
      return [{ text: queryText } as Part];
    }

    const parts: Part[] = [{ text: queryText } as Part];
    const toolArgs = { paths: pathSpecsToRead, respectGitIgnore };
    try {
      const result = await readManyFilesTool.execute(toolArgs, signal);
      if (Array.isArray(result.llmContent)) {
        const fileRe = /^--- (.*?) ---\n\n([\s\S]*?)\n\n$/;
        parts.push({ text: `\n${REFERENCE_CONTENT_START}` } as Part);
        for (const part of result.llmContent) {
          if (typeof part === 'string') {
            const m = fileRe.exec(part);
            if (m) {
              parts.push({ text: `\nContent from @${m[1]}:\n` } as Part);
              parts.push({ text: m[2].trim() } as Part);
            } else {
              parts.push({ text: part } as Part);
            }
          } else {
            parts.push(part);
          }
        }
        parts.push({ text: `\n${REFERENCE_CONTENT_END}` } as Part);
      }
    } catch (err) {
      this.debug(
        `Error reading referenced files (${labels.join(', ')}): ${getErrorMessage(err)}`,
      );
    }
    return parts;
  }

  private debug(msg: string): void {
    if (this.config.getDebugMode()) {
      // stderr so we don't corrupt the ACP stdout frames.
      console.error(`[acp:${this.id}] ${msg}`);
    }
  }

  // Silence the unused-import linter for AuthType; it's re-exported by
  // session manager and kept here for future auth-override hooks.
  private readonly _authTypeRef = _AuthType;
}

export type { _AuthType };
