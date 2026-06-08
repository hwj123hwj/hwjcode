/**
 * @license
 * Copyright 2025 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DelegateToClaudeCodeTool, formatClaudeCodeTaskResult } from './delegate-agent.js';
import type { Config } from '../config/config.js';
import * as acpClient from '../acp-client/acpAgentClient.js';
import { getBackgroundTaskManager } from '../services/backgroundTaskManager.js';

vi.mock('../acp-client/acpAgentClient.js', () => ({
  runDelegatedTask: vi.fn(),
}));

const runDelegatedTask = vi.mocked(acpClient.runDelegatedTask);

function makeTool(targetDir = '/proj') {
  const config = {
    getTargetDir: () => targetDir,
  } as unknown as Config;
  return new DelegateToClaudeCodeTool(config);
}

describe('DelegateToClaudeCodeTool', () => {
  beforeEach(() => {
    runDelegatedTask.mockReset();
    // Clear the singleton between tests so tasks don't accumulate.
    const mgr = getBackgroundTaskManager();
    mgr.clearAllTasks();
  });

  it('rejects an empty task', async () => {
    const tool = makeTool();
    const res = await tool.execute({ task: '   ' }, new AbortController().signal);
    expect(res.status).toBe('failed');
    expect(runDelegatedTask).not.toHaveBeenCalled();
  });

  it('returns immediately with a Task ID (async mode)', async () => {
    // Make runDelegatedTask hang forever so we can observe the early return.
    runDelegatedTask.mockReturnValue(new Promise(() => {}));

    const tool = makeTool('/my/project');
    const res = await tool.execute(
      { task: 'add unit tests for foo' },
      new AbortController().signal,
    );

    // Should return immediately with status 'success' (meaning the launch succeeded).
    expect(res.status).toBe('success');
    expect(res.returnDisplay).toContain('Task ID:');
    expect(res.returnDisplay).toContain('Claude Code');
    expect(res.llmContent).toContain('"status":"running"');
    expect(res.llmContent).toContain('"taskId"');
  });

  it('defaults cwd to the project target dir', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'success',
      label: 'Claude Code',
      answer: 'Done',
      transcript: 'Done',
      stopReason: 'end_turn',
    });

    const tool = makeTool('/my/project');
    await tool.execute({ task: 'add tests' }, new AbortController().signal);

    // Wait a tick for the async task to start.
    await vi.waitFor(() => {
      expect(runDelegatedTask).toHaveBeenCalledTimes(1);
    });
    const arg = runDelegatedTask.mock.calls[0][0];
    expect(arg.agentType).toBe('claude-code');
    expect(arg.cwd).toBe('/my/project');
    expect(arg.autoApprove).toBe(true);
  });

  it('honors an explicit cwd', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'success',
      label: 'Claude Code',
      answer: 'ok',
      transcript: 'ok',
      stopReason: 'end_turn',
    });
    const tool = makeTool('/default');
    await tool.execute(
      { task: 'do x', cwd: '/explicit' },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(runDelegatedTask).toHaveBeenCalledTimes(1);
    });
    expect(runDelegatedTask.mock.calls[0][0].cwd).toBe('/explicit');
  });

  it('completes the background task when runDelegatedTask succeeds', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'success',
      label: 'Claude Code',
      answer: 'Done: added tests',
      transcript: '🔧 Edit\nDone: added tests',
      stopReason: 'end_turn',
    });

    const tool = makeTool();
    const res = await tool.execute({ task: 'add tests' }, new AbortController().signal);
    const llmStr = typeof res.llmContent === 'string' ? res.llmContent : JSON.stringify(res.llmContent);
    const taskIdMatch = llmStr.match(/"taskId":"([^"]+)"/);
    expect(taskIdMatch).toBeTruthy();
    const taskId = taskIdMatch![1];

    // Wait for the async completion.
    await vi.waitFor(() => {
      const task = getBackgroundTaskManager().getTask(taskId);
      expect(task?.status).toBe('completed');
    });

    const bgTask = getBackgroundTaskManager().getTask(taskId)!;
    expect(bgTask.answer).toBe('Done: added tests');
    expect(bgTask.kind).toBe('claude-code');
  });

  it('fails the background task when runDelegatedTask fails', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'failed',
      label: 'Claude Code',
      answer: '',
      transcript: '',
      error: 'Could not launch Claude Code. Make sure it is installed.',
    });

    const tool = makeTool();
    const res = await tool.execute({ task: 'do x' }, new AbortController().signal);
    const llmStr = typeof res.llmContent === 'string' ? res.llmContent : JSON.stringify(res.llmContent);
    const taskIdMatch = llmStr.match(/"taskId":"([^"]+)"/);
    const taskId = taskIdMatch![1];

    await vi.waitFor(() => {
      const task = getBackgroundTaskManager().getTask(taskId);
      expect(task?.status).toBe('failed');
    });

    const bgTask = getBackgroundTaskManager().getTask(taskId)!;
    expect(bgTask.error).toContain('Could not launch Claude Code');
  });

  it('cancels the background task when runDelegatedTask is cancelled', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'cancelled',
      label: 'Claude Code',
      answer: '',
      transcript: '',
      error: 'Delegated task was cancelled.',
    });

    const tool = makeTool();
    const res = await tool.execute({ task: 'do x' }, new AbortController().signal);
    const llmStr = typeof res.llmContent === 'string' ? res.llmContent : JSON.stringify(res.llmContent);
    const taskIdMatch = llmStr.match(/"taskId":"([^"]+)"/);
    const taskId = taskIdMatch![1];

    await vi.waitFor(() => {
      const task = getBackgroundTaskManager().getTask(taskId);
      expect(task?.status).toBe('cancelled');
    });
  });
});

describe('formatClaudeCodeTaskResult', () => {
  it('formats a completed claude-code task with answer', () => {
    const now = Date.now();
    const result = formatClaudeCodeTaskResult({
      id: 'abc1234',
      command: '[Claude Code] refactor auth module',
      kind: 'claude-code',
      status: 'completed',
      startTime: now - 60_000,
      endTime: now,
      output: '🔧 Edit auth.ts\n✅ auth.ts',
      stderr: '',
      answer: 'Refactored auth module successfully.',
    });
    expect(result).toContain('Claude Code task completed');
    expect(result).toContain('abc1234');
    expect(result).toContain('Refactored auth module successfully.');
    expect(result).toContain('60 seconds');
  });

  it('formats a failed task with error', () => {
    const result = formatClaudeCodeTaskResult({
      id: 'def5678',
      command: '[Claude Code] fix bug',
      kind: 'claude-code',
      status: 'failed',
      startTime: 1000000,
      endTime: 1000030,
      output: '',
      stderr: '',
      error: 'Connection timeout',
    });
    expect(result).toContain('failed');
    expect(result).toContain('Connection timeout');
  });
});
