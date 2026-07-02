/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the builtinWorkflows registry and batch-parallel template generation.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveBuiltinWorkflow,
  isBuiltinWorkflow,
  listBuiltinWorkflows,
  getBuiltinMeta,
} from './builtinWorkflows.js';

describe('builtinWorkflows registry', () => {
  it('lists batch-parallel as an available builtin', () => {
    const names = listBuiltinWorkflows();
    expect(names).toContain('batch-parallel');
  });

  it('recognizes batch-parallel as a known builtin', () => {
    expect(isBuiltinWorkflow('batch-parallel')).toBe(true);
  });

  it('rejects unknown names', () => {
    expect(isBuiltinWorkflow('nonexistent')).toBe(false);
  });

  it('getBuiltinMeta returns metadata with autoWorktree=true for batch-parallel', () => {
    const meta = getBuiltinMeta('batch-parallel');
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('batch-parallel');
    expect(meta!.autoWorktree).toBe(true);
  });

  it('returns null for unknown meta', () => {
    expect(getBuiltinMeta('nonexistent')).toBeUndefined();
  });
});

describe('resolveBuiltinWorkflow — batch-parallel', () => {
  it('returns null for unknown name', () => {
    expect(resolveBuiltinWorkflow('unknown', {})).toBeNull();
  });

  it('generates a valid script from args.tasks', () => {
    const result = resolveBuiltinWorkflow('batch-parallel', {
      tasks: [
        { prompt: 'Fix login bug', name: 'fix-login' },
        { prompt: 'Add dark mode', name: 'feat-dark-mode' },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.autoWorktree).toBe(true);

    const script = result!.script;

    // Must contain the injected args
    expect(script).toContain('Fix login bug');
    expect(script).toContain('Add dark mode');
    expect(script).toContain('fix-login');
    expect(script).toContain('feat-dark-mode');

    // Must be a valid workflow script shape
    expect(script).toContain('export const meta');
    expect(script).toContain('export default');
    expect(script).toContain('agent.runParallel');

    // Must enable worktree isolation on each task
    expect(script).toContain('worktree: true');
  });

  it('handles empty tasks array gracefully', () => {
    const result = resolveBuiltinWorkflow('batch-parallel', { tasks: [] });

    expect(result).not.toBeNull();
    expect(result!.script).toContain('No tasks provided');
  });

  it('handles null args', () => {
    const result = resolveBuiltinWorkflow('batch-parallel', null);

    expect(result).not.toBeNull();
    expect(result!.script).toContain('No tasks provided');
  });

  it('handles tasks without optional label/name fields', () => {
    const result = resolveBuiltinWorkflow('batch-parallel', {
      tasks: [{ prompt: 'Do something' }],
    });

    expect(result).not.toBeNull();
    // Should fall back to task-N naming via runtime expression
    expect(result!.script).toContain('task-');
  });

  it('properly escapes special characters in prompts', () => {
    const tricky = 'Task with "quotes" and \\ backslash and ${template}';
    const result = resolveBuiltinWorkflow('batch-parallel', {
      tasks: [{ prompt: tricky }],
    });

    expect(result).not.toBeNull();
    // The JSON.stringify'd args should contain the escaped text
    expect(result!.script).toContain('quotes');
    // Must not break script syntax — the template literal injection is via JSON.stringify
    expect(result!.script).toContain('export default');
  });
});
