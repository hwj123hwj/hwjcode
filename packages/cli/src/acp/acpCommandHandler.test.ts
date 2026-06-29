/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from 'deepv-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { CommandHandler } from './acpCommandHandler.js';

function makeContext(targetDir: string = process.cwd()): {
  config: Config;
  settings: LoadedSettings;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const config = {
    getUserMemory: () => '',
    getGeminiMdFileCount: () => 0,
    getGeminiMdFilePaths: () => [],
    getTargetDir: () => targetDir,
    getModel: () => 'auto',
  } as unknown as Config;
  const settings = {
    merged: { selectedAuthType: 'proxy-auth' },
  } as unknown as LoadedSettings;
  const sendMessage = vi.fn<[string], Promise<void>>(async () => undefined);
  return { config, settings, sendMessage };
}

describe('CommandHandler', () => {
  it('lists the default built-in commands', async () => {
    const handler = new CommandHandler();
    const names = (await handler.getAvailableCommands()).map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'help',
        'about',
        'memory',
        'memory show',
        'memory list',
        'init',
        'extensions',
      ]),
    );
    // `/restore` is intentionally not advertised to ACP clients while the
    // checkpoint flow is still a core-side stub. The user-facing rewind
    // gesture goes through the `_dvcode/session/rewind` extension RPC.
    expect(names).not.toContain('restore');
  });

  it('returns false for non-slash text', async () => {
    const handler = new CommandHandler();
    const ctx = makeContext();
    const result = await handler.handleCommand('just a question', ctx);
    expect(result.handled).toBe(false);
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('executes /help and emits a help banner', async () => {
    const handler = new CommandHandler();
    const ctx = makeContext();
    const result = await handler.handleCommand('/help', ctx);
    expect(result.handled).toBe(true);
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
    const msg = ctx.sendMessage.mock.calls[0][0] as string;
    expect(msg).toMatch(/Easy Code Help/);
    expect(msg).toMatch(/\/help/);
  });

  it('resolves multi-word commands (memory show)', async () => {
    const handler = new CommandHandler();
    const ctx = makeContext();
    const result = await handler.handleCommand('/memory show', ctx);
    expect(result.handled).toBe(true);
    expect(ctx.sendMessage).toHaveBeenCalled();
    const msg = ctx.sendMessage.mock.calls[0][0] as string;
    expect(msg).toMatch(/Memory is currently empty\.|Current memory content/);
  });

  it('surfaces /init as a submitPrompt (run through the model, not echoed)', async () => {
    // A dedicated command whose action is a `submit_prompt` (here `/init` when
    // no DEEPV.md exists) must hand its expanded prompt back via `submitPrompt`
    // so the ACP session feeds it to the model — exactly like the CLI. It must
    // NOT be echoed as a plain message (that was the desktop bug).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-init-'));
    try {
      const handler = new CommandHandler();
      const ctx = makeContext(dir);
      const result = await handler.handleCommand('/init', ctx);
      expect(result.handled).toBe(true);
      expect(typeof result.submitPrompt).toBe('string');
      expect(result.submitPrompt).toMatch(/DEEPV\.md/);
      // The prompt is submitted, never echoed back to the client.
      expect(ctx.sendMessage).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('echoes /init as a message (no submitPrompt) when DEEPV.md already exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-init-'));
    try {
      await fs.writeFile(path.join(dir, 'DEEPV.md'), '# existing');
      const handler = new CommandHandler();
      const ctx = makeContext(dir);
      const result = await handler.handleCommand('/init', ctx);
      expect(result.handled).toBe(true);
      expect(result.submitPrompt).toBeUndefined();
      expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
      expect(ctx.sendMessage.mock.calls[0][0]).toMatch(/already exists/i);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits an error message for unknown subcommands (falls back to parent)', async () => {
    const handler = new CommandHandler();
    const ctx = makeContext();
    const result = await handler.handleCommand('/memory bogus', ctx);
    // "memory" parent matches, but there's no "memory bogus" subcommand so the
    // parent executor runs with args = ["bogus"].
    expect(result.handled).toBe(true);
    expect(ctx.sendMessage).toHaveBeenCalled();
  });
});
