/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from 'deepv-code-core';
import type {
  Command,
  CommandContext,
  CommandExecutionResponse,
} from './commands/types.js';
import { CommandRegistry } from './commands/commandRegistry.js';
import { MemoryCommand } from './commands/memory.js';
import { InitCommand } from './commands/init.js';
import { AboutCommand } from './commands/about.js';
import { HelpCommand } from './commands/help.js';
import { ExtensionsCommand } from './commands/extensions.js';
import {
  buildAdvertisedCommands,
  loadRealCommands,
  runRealCommand,
  type AcpCommandMeta,
  type DispatchResult,
} from './acpCommandBridge.js';

/**
 * Handles slash-command interception and dispatch for ACP prompts.
 *
 * Mirrors gemini-cli's command handler, but registers the (smaller) set of
 * commands DeepCode ships today. Additional commands can be added simply by
 * pushing them into {@link CommandHandler.createRegistry}.
 *
 * NOTE: `/restore` is intentionally not registered here. Checkpoint
 * restoration in DeepCode is still a stub at the core layer (see
 * `core/src/commands/restore.ts`), and exposing the slash command would
 * surface a non-functional button to ACP clients. The user-facing "rewind
 * conversation" gesture is handled by the `_dvcode/session/rewind`
 * extension RPC instead — IDEs trigger it directly from their UI.
 */
export class CommandHandler {
  private readonly registry: CommandRegistry;

  constructor() {
    this.registry = CommandHandler.createRegistry();
  }

  private static createRegistry(): CommandRegistry {
    const registry = new CommandRegistry();
    registry.register(new MemoryCommand());
    registry.register(new ExtensionsCommand());
    registry.register(new InitCommand());
    registry.register(new AboutCommand());
    registry.register(new HelpCommand(registry));
    return registry;
  }

  /**
   * The full slash-command set advertised to ACP clients. Unions the
   * purpose-built headless commands (which produce nicer output, e.g. multi-word
   * `memory show`) with the real CLI command set sourced from
   * {@link loadRealCommands}, so the desktop `/` popup matches the CLI.
   *
   * Falls back to just the headless set if the real loader is unavailable.
   */
  async getAvailableCommands(
    config: Config | null = null,
  ): Promise<AcpCommandMeta[]> {
    const dedicated: AcpCommandMeta[] = this.registry
      .getAllCommands()
      .map((c) => ({ name: c.name, description: c.description }));

    let real: AcpCommandMeta[] = [];
    try {
      real = buildAdvertisedCommands(await loadRealCommands(config));
    } catch {
      // The CLI command tree may be unavailable in stripped builds; the
      // headless set alone keeps the popup non-empty.
    }

    // Merge by name. The headless set wins on conflicts (its descriptions are
    // tuned for the ACP surface) and contributes its multi-word subcommands.
    const byName = new Map<string, AcpCommandMeta>();
    for (const c of real) byName.set(c.name, c);
    for (const c of dedicated) byName.set(c.name, c);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Parse and execute a slash-command. The headless registry is tried first
   * (its commands are tuned for ACP); anything it doesn't own falls through to
   * the real CLI command set via {@link runRealCommand}.
   *
   * Returns `{ handled }` so the caller can skip the LLM round trip, plus an
   * optional `submitPrompt` when a command expanded into a prompt to run.
   */
  async handleCommand(
    commandText: string,
    context: CommandContext,
  ): Promise<DispatchResult> {
    const trimmed = commandText.trim();
    if (!trimmed.startsWith('/') && !trimmed.startsWith('$')) {
      return { handled: false };
    }
    const parsed = this.parseSlashCommand(commandText);
    if (parsed.commandToExecute) {
      return this.runCommand(parsed.commandToExecute, parsed.args, context);
    }
    // Not one of the headless built-ins — try the real CLI command set.
    return runRealCommand(commandText, context);
  }

  private async runCommand(
    command: Command,
    args: string,
    context: CommandContext,
  ): Promise<DispatchResult> {
    try {
      const result: CommandExecutionResponse = await command.execute(
        context,
        args ? args.split(/\s+/) : [],
      );

      // A `submit_prompt` command (e.g. `/init`) expanded into a prompt to run
      // through the model. Hand it up instead of echoing it as text, so the ACP
      // session submits it as the next user turn — matching the CLI behavior.
      if (typeof result.submitPrompt === 'string' && result.submitPrompt) {
        return { handled: true, submitPrompt: result.submitPrompt };
      }

      let message = '';
      if (typeof result.data === 'string') {
        message = result.data;
      } else if (
        typeof result.data === 'object' &&
        result.data !== null &&
        'content' in result.data
      ) {
        message = String(
          (result.data as { content: unknown }).content ?? '',
        );
      } else {
        message = JSON.stringify(result.data, null, 2);
      }
      await context.sendMessage(message);
      return { handled: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await context.sendMessage(`Error: ${msg}`);
      return { handled: true };
    }
  }

  /**
   * Parse a raw `/foo bar baz arg1 arg2` query into a `{command, args}` pair.
   * Walks the registry prefix-first so multi-word names (`"memory show"`)
   * are matched as deeply as possible.
   */
  private parseSlashCommand(query: string): {
    commandToExecute: Command | undefined;
    args: string;
  } {
    const trimmed = query.trim();
    // Tolerate both `/` and `$` prompts as command entries.
    const stripped = trimmed.startsWith('/') || trimmed.startsWith('$')
      ? trimmed.slice(1).trim()
      : trimmed;
    const parts = stripped.split(/\s+/).filter(Boolean);

    let currentCommands = this.registry.getAllCommands();
    let commandToExecute: Command | undefined;
    let pathIndex = 0;

    for (const part of parts) {
      const expected = parts.slice(0, pathIndex + 1).join(' ');
      const found = currentCommands.find(
        (cmd) =>
          cmd.name === part ||
          cmd.name === expected ||
          cmd.aliases?.includes(part) ||
          cmd.aliases?.includes(expected),
      );
      if (!found) break;
      commandToExecute = found;
      pathIndex++;
      if (found.subCommands) currentCommands = found.subCommands;
      else break;
    }

    const args = parts.slice(pathIndex).join(' ');
    return { commandToExecute, args };
  }
}
