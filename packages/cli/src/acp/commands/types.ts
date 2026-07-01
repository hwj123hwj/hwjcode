/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from 'deepv-code-core';
import type { LoadedSettings } from '../../config/settings.js';

/**
 * Execution context handed to every ACP slash-command.
 *
 * gemini-cli uses a richer `AgentLoopContext`; DeepCode's ACP layer only
 * needs the current `Config` and `LoadedSettings`, plus a `sendMessage`
 * callback that forwards text back to the IDE via `session/update`.
 */
export interface CommandContext {
  readonly config: Config;
  readonly settings: LoadedSettings;
  readonly sendMessage: (text: string) => Promise<void>;
}

export interface CommandArgument {
  readonly name: string;
  readonly description: string;
  readonly isRequired?: boolean;
}

export interface Command {
  readonly name: string;
  readonly aliases?: string[];
  readonly description: string;
  readonly arguments?: CommandArgument[];
  readonly subCommands?: Command[];
  readonly requiresWorkspace?: boolean;

  execute(
    context: CommandContext,
    args: string[],
  ): Promise<CommandExecutionResponse>;
}

export interface CommandExecutionResponse {
  readonly name: string;
  readonly data: unknown;
  /**
   * When set, the command expanded into a prompt that must be run through the
   * model (a `submit_prompt` action), rather than echoed back as text. The ACP
   * session injects this as the next user turn — mirroring the CLI, where
   * `/init`, `/ppt`, etc. trigger a model generation instead of printing.
   */
  readonly submitPrompt?: string;
}
