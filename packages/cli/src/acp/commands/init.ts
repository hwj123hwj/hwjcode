/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AcpCommands } from 'deepv-code-core';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  Command,
  CommandContext,
  CommandExecutionResponse,
} from './types.js';

export class InitCommand implements Command {
  readonly name = 'init';
  readonly description = 'Generate DEEPV.md for this project';

  async execute(
    context: CommandContext,
    _args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const cwd =
      (context.config as unknown as { getTargetDir?: () => string }).getTargetDir?.() ??
      process.cwd();
    const memoryFile = path.join(cwd, 'DEEPV.md');

    let exists = false;
    try {
      await fs.access(memoryFile);
      exists = true;
    } catch {
      // missing is expected
    }

    const result = AcpCommands.performInit(exists);
    switch (result.type) {
      case 'message':
        return { name: this.name, data: result.content };
      case 'submit_prompt':
        return { name: this.name, data: result.content };
      default:
        return { name: this.name, data: JSON.stringify(result) };
    }
  }
}
