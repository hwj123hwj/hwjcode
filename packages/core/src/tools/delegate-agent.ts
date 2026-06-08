/**
 * @license
 * Copyright 2025 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import { BaseTool, Icon, type ToolResult } from './tools.js';
import { type Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { runDelegatedTask } from '../acp-client/acpAgentClient.js';
import {
  getBackgroundTaskManager,
  type BackgroundTask,
} from '../services/backgroundTaskManager.js';

/** Parameters for {@link DelegateToClaudeCodeTool}. */
export interface DelegateToClaudeCodeParams {
  /** The full task/instruction handed to Claude Code. */
  task: string;
  /**
   * Absolute working directory for the delegated task. Defaults to the current
   * project root. In Feishu mode this is the chat's bound project.
   */
  cwd?: string;
}

/** Result shape for {@link DelegateToClaudeCodeTool}. */
export interface DelegateToClaudeCodeResult extends ToolResult {
  status: 'success' | 'failed' | 'cancelled' | 'timed_out';
}

/**
 * Delegates a coding task to the user's local Claude Code, with Easy Code acting
 * as the ACP orchestrator. Claude Code runs asynchronously in the bound project —
 * the main agent is free to continue other work while the delegated task runs.
 * Completion is reported through the BackgroundTaskManager event system.
 */
export class DelegateToClaudeCodeTool extends BaseTool<
  DelegateToClaudeCodeParams,
  DelegateToClaudeCodeResult
> {
  static readonly Name: string = 'delegate_to_claude_code';

  constructor(private readonly config: Config) {
    super(
      DelegateToClaudeCodeTool.Name,
      'DelegateToClaudeCode',
      [
        "Delegate a coding task to the user's local Claude Code agent asynchronously.",
        '',
        'WHEN TO USE THIS TOOL (delegate) vs. doing it yourself:',
        '- Delegate when the task is a substantial, self-contained coding job best handled by Claude Code: implementing a feature, refactoring across files, fixing a bug end-to-end, writing tests, etc.',
        '- Delegate when the user explicitly asks for Claude Code (e.g. "让 claude code 来做", "用 cc 改").',
        '- Do it YOURSELF for quick reads, questions, explanations, small edits, or anything where spinning up an external agent is overkill.',
        '',
        'BEHAVIOR (ASYNC):',
        '- Claude Code runs in the background — this tool returns immediately with a Task ID.',
        '- You CAN continue other work while the delegated task runs.',
        '- When the task completes, you will receive a system notification with the result.',
        '- DO NOT wait or poll for the result. Just proceed with your next action.',
        '- Claude Code runs locally in the bound project directory and CAN modify files (permissions are auto-approved).',
        '- It uses the machine\'s own Claude Code login; no extra credentials are passed.',
        '- Provide a complete, self-contained instruction in `task` — Claude Code does not see this conversation.',
      ].join('\n'),
      Icon.Hammer,
      {
        type: Type.OBJECT,
        properties: {
          task: {
            type: Type.STRING,
            description:
              'The complete, self-contained instruction for Claude Code. Include all context it needs, since it does not see the current conversation.',
          },
          cwd: {
            type: Type.STRING,
            description:
              'Optional absolute working directory. Defaults to the current project root.',
          },
        },
        required: ['task'],
      },
      true, // isOutputMarkdown
      false, // forceMarkdown
      true, // canUpdateOutput — stream Claude Code's live progress
      false, // allowSubAgentUse — this IS a dispatcher; do not let sub-agents recurse
    );
  }

  validateToolParams(params: DelegateToClaudeCodeParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      DelegateToClaudeCodeTool.Name,
    );
    if (errors) {
      return errors;
    }
    if (
      !params.task ||
      typeof params.task !== 'string' ||
      params.task.trim() === ''
    ) {
      return 'Parameter "task" must be a non-empty string.';
    }
    if (params.cwd !== undefined && typeof params.cwd !== 'string') {
      return 'Parameter "cwd" must be a string.';
    }
    return null;
  }

  getDescription(params: DelegateToClaudeCodeParams): string {
    const preview = params.task.replace(/\s+/g, ' ').slice(0, 80);
    return `Delegating to Claude Code: "${preview}${params.task.length > 80 ? '…' : ''}"`;
  }

  async execute(
    params: DelegateToClaudeCodeParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<DelegateToClaudeCodeResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        status: 'failed',
        llmContent: JSON.stringify({ status: 'failed', error: validationError }),
        returnDisplay: `Parameter validation failed: ${validationError}`,
        summary: 'Failed',
      };
    }

    const cwd = params.cwd ?? this.config.getTargetDir();
    const taskManager = getBackgroundTaskManager();
    const bgTask = taskManager.createTask(
      `[Claude Code] ${params.task.replace(/\s+/g, ' ').slice(0, 120)}`,
      cwd,
      'claude-code',
    );

    // Fire-and-forget: run the ACP session in the background and update
    // the BackgroundTaskManager on completion.
    this.runAsync(params, cwd, bgTask.id, signal, updateOutput).catch(() => {
      // Should never happen — errors are handled inside runAsync.
    });

    // Return immediately so the main agent can continue working.
    return {
      status: 'success',
      llmContent: JSON.stringify({
        status: 'running',
        taskId: bgTask.id,
        task: params.task,
        message: 'Claude Code task started in the background. You will be notified when it completes.',
      }),
      returnDisplay:
        `🚀 Claude Code 任务已启动 (Task ID: ${bgTask.id})\n\n` +
        `你可以在等待期间继续执行其他任务。任务完成后系统会自动通知你。`,
      summary: `Claude Code started (Task ID: ${bgTask.id})`,
    };
  }

  /**
   * Default timeout for delegated tasks. Claude Code coding tasks can
   * legitimately run for many minutes (large refactors, running test suites,
   * etc.), so we default to 60 minutes. Override with the environment
   * variable EASYCODE_CC_TIMEOUT_MINUTES.
   */
  static readonly DEFAULT_TIMEOUT_MS = (() => {
    const env = process.env.EASYCODE_CC_TIMEOUT_MINUTES;
    if (env) {
      const mins = parseInt(env, 10);
      if (mins > 0) return mins * 60 * 1000;
    }
    return 60 * 60 * 1000; // 60 minutes
  })();

  /**
   * Runs the delegated ACP task in the background, updating the
   * BackgroundTaskManager with streaming output and final result.
   */
  private async runAsync(
    params: DelegateToClaudeCodeParams,
    cwd: string,
    taskId: string,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<void> {
    const taskManager = getBackgroundTaskManager();

    // Forward streaming output to both the updateOutput callback (for
    // live UI) and the BackgroundTaskManager (for state tracking).
    const onStreamUpdate = (output: string) => {
      taskManager.appendOutput(taskId, output);
      updateOutput?.(output);
    };

    try {
      const result = await runDelegatedTask({
        agentType: 'claude-code',
        task: params.task,
        cwd,
        signal,
        onUpdate: onStreamUpdate,
        autoApprove: true,
        timeoutMs: DelegateToClaudeCodeTool.DEFAULT_TIMEOUT_MS,
      });

      // Write the final answer into the task record.
      const task = taskManager.getTask(taskId);
      if (task) {
        task.answer = result.answer || result.transcript;
      }

      if (result.status === 'success') {
        taskManager.completeTask(taskId, { exitCode: 0 });
      } else if (result.status === 'cancelled') {
        taskManager.cancelTask(taskId);
      } else {
        taskManager.failTask(taskId, result.error || `${result.label} ${result.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      taskManager.failTask(taskId, msg);
    }
  }
}

/**
 * Format a completed Claude Code background task result for AI consumption.
 * Called from the UI layer (App.tsx) when building the system notification.
 *
 * IMPORTANT: This text is injected into the main agent's context window.
 * Keep it concise — only the answer and a short summary, never the full
 * transcript.  Long-running tasks can produce tens of thousands of
 * characters of tool output; dumping all of that into the LLM context
 * would blow up token usage and degrade response quality.
 */
export function formatClaudeCodeTaskResult(task: BackgroundTask): string {
  const duration = task.endTime ? Math.round((task.endTime - task.startTime) / 1000) : 0;

  let result = `Claude Code task completed:\n`;
  result += `- Task ID: ${task.id}\n`;
  result += `- Duration: ${duration} seconds\n`;
  result += `- Status: ${task.status}\n`;

  if (task.answer?.trim()) {
    // The concise answer from Claude Code — typically a summary paragraph.
    const trimmed = task.answer.length > 2000
      ? task.answer.slice(0, 2000) + '…'
      : task.answer;
    result += `\n--- Answer ---\n${trimmed}\n`;
  } else if (task.output?.trim()) {
    // Fallback: extract just the tool call titles and final text, not the
    // verbose transcript.  Keep under 1500 chars to protect context window.
    const summary = extractCompactSummary(task.output, 1500);
    result += `\n--- Summary ---\n${summary}\n`;
  }

  if (task.error) {
    result += `\n--- Error ---\n${task.error.slice(0, 500)}\n`;
  }

  return result;
}

/**
 * Extract a compact summary from a verbose transcript: keep tool call
 * titles (lines starting with emoji markers) and the last few lines of
 * text output, discarding verbose file contents and diffs.
 */
export function extractCompactSummary(transcript: string, maxLen: number): string {
  const lines = transcript.split('\n');
  const kept: string[] = [];
  let len = 0;

  // Walk backwards so we keep the most recent content.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Keep: tool call markers, status lines, short text lines
    const isToolMarker = /^[📖✏️🗑️📦🔍⚡💭🌐🔄🔧✅⚠️📋📊💡🚀⏳⏹️⏱️❌]/u.test(line);
    const isShort = line.length <= 200;
    const candidate = isToolMarker || isShort ? line : line.slice(0, 100) + '…';

    if (len + candidate.length + 1 > maxLen) break;
    kept.unshift(candidate);
    len += candidate.length + 1;
  }

  return kept.join('\n');
}
