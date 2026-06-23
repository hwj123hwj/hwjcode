/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { CreateRemoteSessionTool } from './createRemoteSessionTool.js';

function makeFs(exists = false) {
  return {
    existsSync: vi.fn(() => exists),
    mkdirSync: vi.fn(),
  };
}

function makeTool(
  deps: Partial<ConstructorParameters<typeof CreateRemoteSessionTool>[0]> = {},
) {
  const fs = makeFs();
  const createSessionForPath = vi.fn(async () => 'session_new_42');
  const notifySwitch = vi.fn();
  const tool = new CreateRemoteSessionTool({
    createSessionForPath,
    notifySwitch,
    fs,
    ...deps,
  });
  return { tool, fs, createSessionForPath, notifySwitch };
}

const ABORT = new AbortController().signal;

describe('CreateRemoteSessionTool.validateToolParams', () => {
  it('rejects a missing project_path', () => {
    const { tool } = makeTool();
    expect(tool.validateToolParams({ project_path: '' } as any)).toMatch(
      /project_path/,
    );
    expect(tool.validateToolParams({} as any)).toMatch(/project_path/);
  });

  it('rejects a blank project_path', () => {
    const { tool } = makeTool();
    expect(tool.validateToolParams({ project_path: '   ' })).toMatch(
      /project_path/,
    );
  });

  it('accepts a valid absolute project_path', () => {
    const { tool } = makeTool();
    expect(
      tool.validateToolParams({ project_path: 'D:\\projects\\foo' }),
    ).toBeNull();
  });
});

describe('CreateRemoteSessionTool.execute — happy path', () => {
  it('creates the directory when missing, then creates + notifies switch', async () => {
    const { tool, fs, createSessionForPath, notifySwitch } = makeTool();
    const res = await tool.execute(
      { project_path: 'D:\\projects\\another-project' },
      ABORT,
    );

    const abs = path.resolve('D:\\projects\\another-project');

    // Directory was created recursively because existsSync returned false.
    expect(fs.mkdirSync).toHaveBeenCalledWith(abs, { recursive: true });

    // Reverse-called the server with the resolved absolute path.
    expect(createSessionForPath).toHaveBeenCalledWith(abs);

    // Notified the client to switch to the new session id + path.
    expect(notifySwitch).toHaveBeenCalledWith('session_new_42', abs);

    // Reported success to the LLM.
    expect(res.llmContent).toContain('session_new_42');
    expect(res.llmContent).toContain(abs);
    expect(res.returnDisplay).toContain('session_new_42');
  });

  it('skips mkdir when the directory already exists', async () => {
    const fs = makeFs(true);
    const { tool, createSessionForPath } = makeTool({ fs });
    await tool.execute({ project_path: '/home/me/repo' }, ABORT);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(createSessionForPath).toHaveBeenCalledWith(path.resolve('/home/me/repo'));
  });

  it('passes the resolved absolute path (not the raw input) to the server', async () => {
    const { tool, createSessionForPath, notifySwitch } = makeTool();
    await tool.execute({ project_path: 'relative/dir' }, ABORT);
    const abs = path.resolve('relative/dir');
    expect(createSessionForPath).toHaveBeenCalledWith(abs);
    expect(notifySwitch).toHaveBeenCalledWith('session_new_42', abs);
  });
});

describe('CreateRemoteSessionTool.execute — error paths', () => {
  it('returns a validation error before any side effects', async () => {
    const { tool, fs, createSessionForPath, notifySwitch } = makeTool();
    const res = await tool.execute({ project_path: '' } as any, ABORT);
    expect(res.llmContent).toContain('Error');
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(createSessionForPath).not.toHaveBeenCalled();
    expect(notifySwitch).not.toHaveBeenCalled();
  });

  it('surfaces server errors and does not notify a switch', async () => {
    const createSessionForPath = vi.fn(async () => {
      throw new Error('boom from server');
    });
    const { tool, notifySwitch } = makeTool({ createSessionForPath });
    const res = await tool.execute({ project_path: '/x/y' }, ABORT);
    expect(res.llmContent).toContain('boom from server');
    expect(notifySwitch).not.toHaveBeenCalled();
  });
});
