/**
 * @license
 * Copyright 2025 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { runDelegatedTask } from './acpAgentClient.js';

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
});
