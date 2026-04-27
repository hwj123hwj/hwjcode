/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TaskTool } from './task.js';

describe('TaskTool', () => {
  it('uses the selected agent display name as the execution description', () => {
    const tool = new TaskTool({} as any, {} as any);

    expect(
      tool.getDescription({
        agent_type: 'code-reviewer',
        prompt: 'Review the latest commit',
        description: '审查最近提交',
        max_turns: 8,
      }),
    ).toBe('Code Reviewer');
  });

  it('keeps the default code-analysis display name when agent_type is omitted', () => {
    const tool = new TaskTool({} as any, {} as any);

    expect(
      tool.getDescription({
        prompt: 'Explore the project',
        description: '探索项目',
        max_turns: 8,
      }),
    ).toBe('Code Analysis Expert');
  });
});
