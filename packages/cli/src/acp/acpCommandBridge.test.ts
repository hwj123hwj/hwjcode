/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from 'deepv-code-core';
import type { LoadedSettings } from '../config/settings.js';
import {
  CommandKind,
  type SlashCommand,
} from '../ui/commands/types.js';
import {
  ACP_INTERACTIVE_ONLY,
  ACP_TERMINAL_ONLY_COMMANDS,
  buildAdvertisedCommands,
  dispatchCommand,
  type DispatchContext,
} from './acpCommandBridge.js';

function makeCtx(): DispatchContext & { sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn<[string], Promise<void>>(async () => undefined);
  return {
    config: { getModel: () => 'auto' } as unknown as Config,
    settings: { merged: {} } as unknown as LoadedSettings,
    sendMessage,
  };
}

function cmd(partial: Partial<SlashCommand> & { name: string }): SlashCommand {
  return {
    description: `desc for ${partial.name}`,
    kind: CommandKind.BUILT_IN,
    ...partial,
  };
}

describe('buildAdvertisedCommands', () => {
  it('drops hidden and interactive-only commands and sorts by name', () => {
    const commands: SlashCommand[] = [
      cmd({ name: 'tools' }),
      cmd({ name: 'about' }),
      cmd({ name: 'newsecret', hidden: true }),
      cmd({ name: 'quit' }), // interactive-only
    ];
    const advertised = buildAdvertisedCommands(commands);
    expect(advertised.map((c) => c.name)).toEqual(['about', 'tools']);
    expect(advertised[0]).toEqual({ name: 'about', description: 'desc for about' });
  });

  it('treats every member of ACP_INTERACTIVE_ONLY as non-advertisable', () => {
    const commands = [...ACP_INTERACTIVE_ONLY].map((name) => cmd({ name }));
    expect(buildAdvertisedCommands(commands)).toEqual([]);
  });

  it('drops terminal-only commands (e.g. the Feishu gateway) from the desktop list', () => {
    // /feishu and /lark are the CLI Feishu input-gateway entry points; they
    // conflict with the desktop GUI and must never reach the `/` popup.
    expect(ACP_TERMINAL_ONLY_COMMANDS.has('feishu')).toBe(true);
    expect(ACP_TERMINAL_ONLY_COMMANDS.has('lark')).toBe(true);

    const commands: SlashCommand[] = [
      cmd({ name: 'feishu', altNames: ['飞书'] }),
      cmd({ name: 'lark', altNames: ['Lark'] }),
      cmd({ name: 'tools' }),
    ];
    // The terminal-only commands are filtered, the rest survive.
    expect(buildAdvertisedCommands(commands).map((c) => c.name)).toEqual([
      'tools',
    ]);
  });
});

describe('dispatchCommand', () => {
  it('returns not-handled for an unknown command', async () => {
    const ctx = makeCtx();
    const res = await dispatchCommand([cmd({ name: 'tools' })], '/nope', ctx);
    expect(res.handled).toBe(false);
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('relays addItem text from a void-returning action', async () => {
    const ctx = makeCtx();
    const tools = cmd({
      name: 'tools',
      action: async (c) => {
        c.ui.addItem({ type: 'info', text: 'tool A\ntool B' } as never, 0);
      },
    });
    const res = await dispatchCommand([tools], '/tools', ctx);
    expect(res.handled).toBe(true);
    expect(res.submitPrompt).toBeUndefined();
    expect(ctx.sendMessage).toHaveBeenCalledWith('tool A\ntool B');
  });

  it('relays a message action', async () => {
    const ctx = makeCtx();
    const ping = cmd({
      name: 'ping',
      action: async () => ({
        type: 'message' as const,
        messageType: 'info' as const,
        content: 'pong',
      }),
    });
    const res = await dispatchCommand([ping], '/ping', ctx);
    expect(res.handled).toBe(true);
    expect(ctx.sendMessage).toHaveBeenCalledWith('pong');
  });

  it('surfaces submit_prompt content for the caller to run through the model', async () => {
    const ctx = makeCtx();
    const ppt = cmd({
      name: 'ppt',
      action: async (_c, args) => ({
        type: 'submit_prompt' as const,
        content: `expanded: ${args}`,
      }),
    });
    const res = await dispatchCommand([ppt], '/ppt my topic', ctx);
    expect(res).toEqual({ handled: true, submitPrompt: 'expanded: my topic' });
    // submit_prompt is run through the LLM, not echoed as a message.
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('answers a dialog action with the interactive-only notice', async () => {
    const ctx = makeCtx();
    const model = cmd({
      name: 'model',
      action: async () => ({ type: 'dialog' as const, dialog: 'model' as const }),
    });
    const res = await dispatchCommand([model], '/model', ctx);
    expect(res.handled).toBe(true);
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.sendMessage.mock.calls[0][0]).toMatch(/model/);
  });

  it('notices interactive-only commands without running their action', async () => {
    const ctx = makeCtx();
    const action = vi.fn();
    const quit = cmd({ name: 'quit', action });
    const res = await dispatchCommand([quit], '/quit', ctx);
    expect(res.handled).toBe(true);
    expect(action).not.toHaveBeenCalled();
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('blocks a terminal-only command without running its action', async () => {
    const ctx = makeCtx();
    const action = vi.fn();
    const feishu = cmd({ name: 'feishu', altNames: ['飞书'], action });
    const res = await dispatchCommand([feishu], '/feishu start', ctx);
    expect(res.handled).toBe(true);
    expect(res.submitPrompt).toBeUndefined();
    expect(action).not.toHaveBeenCalled();
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.sendMessage.mock.calls[0][0]).toMatch(/feishu/);
  });

  it('blocks a terminal-only command invoked via an alias', async () => {
    const ctx = makeCtx();
    const action = vi.fn();
    const feishu = cmd({ name: 'feishu', altNames: ['飞书'], action });
    const res = await dispatchCommand([feishu], '/飞书', ctx);
    expect(res.handled).toBe(true);
    expect(action).not.toHaveBeenCalled();
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('resolves nested subcommands and passes trailing args', async () => {
    const ctx = makeCtx();
    const action = vi.fn(async (_c: unknown, args: string) => ({
      type: 'message' as const,
      messageType: 'info' as const,
      content: `list:${args}`,
    }));
    const skill = cmd({
      name: 'skill',
      subCommands: [cmd({ name: 'list', action: action as never })],
    });
    const res = await dispatchCommand([skill], '/skill list foo', ctx);
    expect(res.handled).toBe(true);
    expect(ctx.sendMessage).toHaveBeenCalledWith('list:foo');
  });

  it('catches a throwing action and reports it as an error message', async () => {
    const ctx = makeCtx();
    const boom = cmd({
      name: 'boom',
      action: async () => {
        throw new Error('kaboom');
      },
    });
    const res = await dispatchCommand([boom], '/boom', ctx);
    expect(res.handled).toBe(true);
    expect(ctx.sendMessage.mock.calls[0][0]).toMatch(/kaboom/);
  });
});
