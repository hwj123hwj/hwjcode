/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  runDelegatedTask,
  formatTerminalMeta,
  extractModelName,
  resolveModelId,
} from './acpAgentClient.js';

const STUB = fileURLToPath(
  new URL('./__fixtures__/stub-acp-agent.mjs', import.meta.url),
);
const CWD = path.dirname(fileURLToPath(import.meta.url));

function nodeLaunch(args: string[] = []) {
  return { command: process.execPath, args: [STUB, ...args] };
}

describe('runDelegatedTask', () => {
  it('handshakes, auto-approves permission, and aggregates the answer', async () => {
    const updates: string[] = [];
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      launchOverride: nodeLaunch(),
      onUpdate: (o) => updates.push(o),
    });

    expect(result.status).toBe('success');
    expect(result.stopReason).toBe('end_turn');
    // Permission was auto-approved → stub echoes the selected option id.
    expect(result.answer).toContain('chose:allow');
    // The transcript surfaced the tool call and the auto-approval marker.
    expect(result.transcript).toContain('Edit src/foo.ts');
    // onUpdate received the cumulative transcript at least once.
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((u) => u.includes('chose:allow'))).toBe(true);
  }, 30_000);

  it('reports cancelled when the signal aborts mid-task', async () => {    const controller = new AbortController();
    const promise = runDelegatedTask({
      agentType: 'claude-code',
      task: 'long task',
      cwd: CWD,
      signal: controller.signal,
      shell: false,
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'hang' },
      },
    });

    // Give the child time to start and hang in prompt, then cancel.
    await new Promise((r) => setTimeout(r, 800));
    controller.abort();

    const result = await promise;
    expect(result.status).toBe('cancelled');
  }, 30_000);

  it('fails fast with guidance when the agent goes silent after starting', async () => {
    const updates: string[] = [];
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      idleTimeoutMs: 500,
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'hang' },
      },
      onUpdate: (o) => updates.push(o),
    });

    // The handshake succeeds but the prompt never streams — the idle watchdog
    // must surface this rather than hanging until the full task timeout.
    expect(result.status).toBe('timed_out');
    expect(result.error).toContain('claude /login');
    // A startup status was pushed immediately so the UI never looks frozen.
    expect(updates.length).toBeGreaterThan(0);
  }, 30_000);

  it('resumes a native session via session/load and reports its id', async () => {
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'continue the work',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      resumeSessionId: 'sess-to-resume',
      launchOverride: nodeLaunch(),
    });

    expect(result.status).toBe('success');
    // The resumed id (not the stub's fresh "stub-session-1") is surfaced.
    expect(result.sessionId).toBe('sess-to-resume');
    expect(result.answer).toContain('chose:allow');
  }, 30_000);

  it('does NOT leak session/load replayed history into the resumed turn', async () => {
    const updates: string[] = [];
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'continue the work',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      resumeSessionId: 'sess-to-resume',
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'replay' },
      },
      onUpdate: (o) => updates.push(o),
    });

    expect(result.status).toBe('success');
    // The new turn's incremental answer is present…
    expect(result.answer).toContain('chose:allow');
    // …but the history replayed by session/load (before the prompt) is NOT —
    // otherwise the caller's head-first truncation would bury the real answer.
    expect(result.answer).not.toContain('OLD_HISTORY_REPLAY');
    expect(result.transcript).not.toContain('OLD_HISTORY_REPLAY');
    // The final streamed transcript is likewise clean of the replay.
    expect(updates[updates.length - 1] ?? '').not.toContain('OLD_HISTORY_REPLAY');
  }, 30_000);

  it('captures structured progress (tool count, plan, token usage)', async () => {
    const snapshots: Array<{ toolCallCount: number }> = [];
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something rich',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'rich' },
      },
      onProgress: (p) => snapshots.push({ toolCallCount: p.toolCallCount }),
    });

    expect(result.status).toBe('success');
    expect(result.progress).toBeDefined();
    expect(result.progress!.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(result.progress!.currentTool).toContain('Edit src/foo.ts');
    // The ACP ToolKind is captured alongside the title for semantic UI icons.
    expect(result.progress!.currentToolKind).toBe('edit');
    // The latest agent narration (emitted after the tool call) is mirrored into
    // structured progress; the tool-call boundary reset the prior buffer first.
    expect(result.progress!.lastMessage).toBe('chose:allow');
    expect(result.progress!.tokenUsed).toBe(1234);
    expect(result.progress!.tokenSize).toBe(10000);
    expect(result.progress!.plan).toHaveLength(3);
    expect(result.progress!.plan![1]).toEqual({
      content: 'Step two',
      status: 'in_progress',
    });
    // The structured callback fired during the turn.
    expect(snapshots.length).toBeGreaterThan(0);
  }, 30_000);

  it('fails with actionable guidance when the agent cannot be launched', async () => {
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      launchOverride: {
        command: 'easycode-nonexistent-binary-xyz',
        args: [],
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('Claude Code');
  }, 30_000);

  it('surfaces real terminal output (_meta) and the external model name', async () => {
    const progressSnaps: Array<{ model?: string }> = [];
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'run a command',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'terminal' },
      },
      onProgress: (p) => progressSnaps.push({ model: p.model }),
    });

    expect(result.status).toBe('success');
    // The real command output (from _meta.terminal_output.data) reaches the
    // transcript instead of the old dead "[terminal output]" placeholder.
    expect(result.transcript).toContain('hello from bash');
    expect(result.transcript).toContain('line two');
    expect(result.transcript).not.toContain('[terminal output]');
    expect(result.transcript).toContain('[exit code: 0]');
    // The external agent's model name is captured into structured progress.
    expect(result.progress?.model).toBe('DeepSeek-V4-Pro');
    expect(progressSnaps.some((s) => s.model === 'DeepSeek-V4-Pro')).toBe(true);
  }, 30_000);

  it('switches the session model via session/set_model when a matching model is requested', async () => {
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      // Request the non-default model by a case-insensitive name substring.
      model: 'gpt-5',
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'setmodel' },
      },
    });

    expect(result.status).toBe('success');
    // The stub echoes back exactly the modelId it received via set_model — it
    // must be the resolved id for "gpt-5", not the default.
    expect(result.answer).toContain('setmodel:gpt-5-codex');
    // The transcript notes the switch, and progress reflects the new model name.
    expect(result.transcript).toContain('已切换模型 → GPT-5 Codex');
    expect(result.progress?.model).toBe('GPT-5 Codex');
  }, 30_000);

  it('does NOT call set_model and does not crash when the requested model has no match', async () => {
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      model: 'no-such-model-xyz',
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'setmodel' },
      },
    });

    expect(result.status).toBe('success');
    // set_model was never invoked → the stub still reports "none".
    expect(result.answer).toContain('setmodel:none');
    expect(result.transcript).toContain('未找到匹配的模型');
    // The agent keeps its default model (no switch line).
    expect(result.transcript).not.toContain('已切换模型');
  }, 30_000);

  it('tolerates a bridge that does not support set_model (keeps default model)', async () => {
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      // The "terminal" stub advertises models but does NOT implement set_model,
      // so the unstable call returns "method not found" — must be tolerated.
      model: 'Other Model',
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'terminal' },
      },
    });

    expect(result.status).toBe('success');
    // The delegation still completes; the client surfaces a gentle notice.
    expect(result.transcript).toContain('不支持运行时切换模型');
  }, 30_000);
});

describe('formatTerminalMeta', () => {
  it('renders a fenced console block with the command output and exit code', () => {
    const out = formatTerminalMeta({
      terminal_output: { data: 'hello\nworld' },
      terminal_exit: { exit_code: 0 },
    });
    expect(out).toContain('```console');
    expect(out).toContain('hello');
    expect(out).toContain('world');
    expect(out).toContain('[exit code: 0]');
  });

  it('returns empty string when there is no terminal output', () => {
    expect(formatTerminalMeta(undefined)).toBe('');
    expect(formatTerminalMeta(null)).toBe('');
    expect(formatTerminalMeta({})).toBe('');
    expect(formatTerminalMeta({ terminal_output: {} })).toBe('');
  });

  it('still surfaces a known exit code even with no output data', () => {
    const out = formatTerminalMeta({ terminal_exit: { exit_code: 137 } });
    expect(out).toContain('[exit code: 137]');
  });

  it('tail-clamps overlong output by lines and chars', () => {
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const out = formatTerminalMeta({ terminal_output: { data: many } }, {
      maxLines: 40,
      maxChars: 2000,
    });
    expect(out).toContain('output truncated');
    // The tail (latest lines) is kept, the head dropped.
    expect(out).toContain('line 199');
    expect(out).not.toContain('line 0\n');
    expect(out.length).toBeLessThan(2200);
  });
});

describe('extractModelName', () => {
  it('returns the name of the current model', () => {
    expect(
      extractModelName({
        currentModelId: 'b',
        availableModels: [
          { modelId: 'a', name: 'Alpha' },
          { modelId: 'b', name: 'Beta' },
        ],
      }),
    ).toBe('Beta');
  });

  it('returns undefined when model state is missing or malformed', () => {
    expect(extractModelName(undefined)).toBeUndefined();
    expect(extractModelName(null)).toBeUndefined();
    expect(extractModelName({})).toBeUndefined();
    expect(extractModelName({ currentModelId: 'x', availableModels: [] })).toBeUndefined();
    expect(
      extractModelName({ currentModelId: 'z', availableModels: [{ modelId: 'a', name: 'A' }] }),
    ).toBeUndefined();
  });
});

describe('resolveModelId', () => {
  const models = {
    currentModelId: 'deepseek-v4-pro',
    availableModels: [
      { modelId: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      { modelId: 'gpt-5-codex', name: 'GPT-5 Codex' },
    ],
  };

  it('matches by exact modelId', () => {
    expect(resolveModelId(models, 'gpt-5-codex')).toBe('gpt-5-codex');
    expect(resolveModelId(models, 'deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  it('matches by case-insensitive name substring', () => {
    expect(resolveModelId(models, 'GPT-5 Codex')).toBe('gpt-5-codex');
    expect(resolveModelId(models, 'codex')).toBe('gpt-5-codex');
    expect(resolveModelId(models, 'CODEX')).toBe('gpt-5-codex');
    expect(resolveModelId(models, 'deepseek')).toBe('deepseek-v4-pro');
  });

  it('prefers an exact modelId match over a name substring match', () => {
    // "gpt-5-codex" is an exact id; it should win even though it also appears
    // as a substring of nothing else here — sanity check the ordering.
    expect(resolveModelId(models, 'gpt-5-codex')).toBe('gpt-5-codex');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(resolveModelId(models, '  gpt-5-codex  ')).toBe('gpt-5-codex');
    expect(resolveModelId(models, '  codex ')).toBe('gpt-5-codex');
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveModelId(models, 'no-such-model')).toBeUndefined();
  });

  it('returns undefined for missing / malformed state or empty input', () => {
    expect(resolveModelId(undefined, 'x')).toBeUndefined();
    expect(resolveModelId(null, 'x')).toBeUndefined();
    expect(resolveModelId({}, 'x')).toBeUndefined();
    expect(resolveModelId({ availableModels: 'nope' }, 'x')).toBeUndefined();
    expect(resolveModelId(models, '')).toBeUndefined();
    expect(resolveModelId(models, '   ')).toBeUndefined();
    expect(resolveModelId(models, undefined as unknown as string)).toBeUndefined();
  });

  it('ignores entries without a string modelId', () => {
    const bad = {
      currentModelId: 'a',
      availableModels: [
        { name: 'No Id Model' },
        { modelId: 123, name: 'Numeric Id' },
        { modelId: 'good', name: 'Good Model' },
      ],
    };
    // Name substring "model" matches multiple entries but only the one with a
    // valid string modelId is returned.
    expect(resolveModelId(bad, 'Good')).toBe('good');
    expect(resolveModelId(bad, 'No Id')).toBeUndefined();
  });
});
