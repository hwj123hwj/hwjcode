/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildRelaunchScript,
  SelfUpdateTool,
  type RelaunchInstallMode,
} from './self-update.js';
import type { Config } from '../config/config.js';

/**
 * SelfUpdateTool / buildRelaunchScript — 飞书模式下"更新并重启 / 仅重启"。
 *
 * 进程不能自杀续命，故由一个 detached 的纯 JS 外挂脚本接力：
 *   父进程退出 → 外挂轮询父 PID 消失 → (按需)安装 → 拉起 easycode --feishu → 自删。
 *
 * 三种安装模式（install）：
 *   - { type: 'none' }            仅重启，不安装
 *   - { type: 'npm' }             npm i -g easycode-ai@latest
 *   - { type: 'tgz', path }       npm i -g <本地 tgz 绝对路径>
 *
 * 同一套外挂机制被 SelfUpdateTool 与 /feishu restart 共用，不造第二套轮子。
 */
describe('buildRelaunchScript', () => {
  const base = {
    parentPid: 12345,
    relaunchCommand: 'easycode',
    relaunchArgs: ['--feishu'],
    scriptPath: '/tmp/easycode-relaunch-12345.js',
  };

  const npmMode: RelaunchInstallMode = { type: 'npm', packageName: 'easycode-ai' };
  const noneMode: RelaunchInstallMode = { type: 'none' };
  const tgzMode: RelaunchInstallMode = { type: 'tgz', path: '/abs/easycode-ai-1.1.3.tgz' };

  it('always embeds parent PID polling via process.kill', () => {
    const script = buildRelaunchScript({ ...base, install: npmMode });
    expect(script).toContain('12345');
    expect(script).toContain('process.kill');
  });

  it('npm mode embeds `<pkg>@latest` install', () => {
    const script = buildRelaunchScript({ ...base, install: npmMode });
    expect(script).toContain('easycode-ai@latest');
    expect(script).toContain('install');
    expect(script).toContain('-g');
  });

  it('tgz mode embeds the local tgz absolute path install', () => {
    const script = buildRelaunchScript({ ...base, install: tgzMode });
    expect(script).toContain('/abs/easycode-ai-1.1.3.tgz');
    expect(script).toContain('install');
    expect(script).toContain('-g');
    // tgz 模式不应出现 @latest
    expect(script).not.toContain('@latest');
  });

  it('none mode (restart only) installs nothing — INSTALL_ARGS is null', () => {
    const script = buildRelaunchScript({ ...base, install: noneMode });
    // 关键：安装参数被禁用（运行时跳过 npm install）
    expect(script).toContain('INSTALL_ARGS = null');
    expect(script).not.toContain('@latest');
    // 仍然要重启
    expect(script).toContain('easycode');
    expect(script).toContain('--feishu');
  });

  it('always embeds the relaunch command and args', () => {
    for (const install of [npmMode, noneMode, tgzMode]) {
      const script = buildRelaunchScript({ ...base, install });
      expect(script).toContain('easycode');
      expect(script).toContain('--feishu');
    }
  });

  it('always self-deletes the temp script', () => {
    for (const install of [npmMode, noneMode, tgzMode]) {
      const script = buildRelaunchScript({ ...base, install });
      expect(script).toContain('unlink');
    }
  });

  it('always uses detached + unref to outlive itself', () => {
    for (const install of [npmMode, noneMode, tgzMode]) {
      const script = buildRelaunchScript({ ...base, install });
      expect(script).toContain('detached');
      expect(script).toContain('unref');
    }
  });

  it('produces valid JavaScript for all modes', () => {
    for (const install of [npmMode, noneMode, tgzMode]) {
      const script = buildRelaunchScript({ ...base, install });
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it('embeds args via JSON to avoid injection', () => {
    const script = buildRelaunchScript({
      ...base,
      install: noneMode,
      relaunchArgs: ['--feishu', '--weird "arg"'],
    });
    expect(script).toContain(JSON.stringify(['--feishu', '--weird "arg"']));
  });

  it('does not branch on OS (single cross-platform path)', () => {
    const script = buildRelaunchScript({ ...base, install: npmMode });
    expect(script).not.toContain('cmd.exe');
    expect(script).not.toContain('/bin/bash');
  });

  it('embeds tgz path via JSON to handle spaces/backslashes safely', () => {
    const winPath = 'C:\\Users\\me\\pkgs\\easycode-ai 1.1.3.tgz';
    const script = buildRelaunchScript({
      ...base,
      install: { type: 'tgz', path: winPath },
    });
    expect(script).toContain(JSON.stringify(winPath));
  });

  // --- relaunch via absolute node + entry script (immune to PATH/nvm/homebrew) ---

  it('prefers absolute node path + entry script when provided (no shell command lookup)', () => {
    const script = buildRelaunchScript({
      ...base,
      install: noneMode,
      relaunchNodePath: '/home/u/.nvm/versions/node/v20.0.0/bin/node',
      relaunchEntryScript: '/home/u/.nvm/versions/node/v20.0.0/lib/node_modules/easycode-ai/dist/index.js',
    });
    // node 绝对路径与入口脚本绝对路径都内联进去
    expect(script).toContain(JSON.stringify('/home/u/.nvm/versions/node/v20.0.0/bin/node'));
    expect(script).toContain(JSON.stringify('/home/u/.nvm/versions/node/v20.0.0/lib/node_modules/easycode-ai/dist/index.js'));
    // 运行时走绝对路径分支（NODE_PATH && ENTRY_SCRIPT 为真），用 spawn(NODE_PATH, [ENTRY_SCRIPT, ...])
    expect(script).toContain('spawn(NODE_PATH, [ENTRY_SCRIPT]');
    // 绝对路径分支不依赖 shell（shell:true 仅保留在 NODE_PATH 缺失时的回退分支里）
    expect(script).toContain('if (NODE_PATH && ENTRY_SCRIPT)');
  });

  it('listens for spawn error event so failures are observable (not silently swallowed)', () => {
    const script = buildRelaunchScript({
      ...base,
      install: noneMode,
      relaunchNodePath: '/usr/bin/node',
      relaunchEntryScript: '/opt/easycode/index.js',
    });
    expect(script).toContain("on('error'");
  });

  it('redirects relaunch output to a log file when logPath is provided', () => {
    const script = buildRelaunchScript({
      ...base,
      install: noneMode,
      relaunchNodePath: '/usr/bin/node',
      relaunchEntryScript: '/opt/easycode/index.js',
      logPath: '/home/u/.easycode-user/relaunch.log',
    });
    expect(script).toContain(JSON.stringify('/home/u/.easycode-user/relaunch.log'));
    // 用 openSync 打开日志 fd 供 stdio 重定向
    expect(script).toContain('openSync');
  });

  it('produces valid JavaScript when using absolute node + entry script', () => {
    const script = buildRelaunchScript({
      ...base,
      install: npmMode,
      relaunchNodePath: '/usr/bin/node',
      relaunchEntryScript: '/opt/easycode/index.js',
      logPath: '/tmp/relaunch.log',
    });
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('SelfUpdateTool', () => {
  const makeConfig = (): Config =>
    ({ getModel: () => 'test-model' }) as unknown as Config;

  it('has the correct tool name and no required params', () => {
    const tool = new SelfUpdateTool(makeConfig());
    expect(tool.name).toBe('self_update');
    expect(tool.schema.parameters?.required ?? []).toEqual([]);
  });

  it('schema exposes action and source params to the model', () => {
    const tool = new SelfUpdateTool(makeConfig());
    const props = (tool.schema.parameters?.properties ?? {}) as Record<string, unknown>;
    expect(props).toHaveProperty('action');
    expect(props).toHaveProperty('source');
  });

  it('validates action enum', () => {
    const tool = new SelfUpdateTool(makeConfig());
    expect(tool.validateToolParams({ action: 'update_and_restart' })).toBeNull();
    expect(tool.validateToolParams({ action: 'restart_only' })).toBeNull();
    expect(tool.validateToolParams({ action: 'bogus' as never })).not.toBeNull();
  });

  it('requires source path when source is a local tgz', () => {
    const tool = new SelfUpdateTool(makeConfig());
    // source=local 但未给 path → 校验失败
    expect(
      tool.validateToolParams({ action: 'update_and_restart', source: 'local' }),
    ).not.toBeNull();
    // 给了 path → 通过
    expect(
      tool.validateToolParams({
        action: 'update_and_restart',
        source: 'local',
        sourcePath: '/abs/pkg.tgz',
      }),
    ).toBeNull();
  });

  it('restart_only ignores source and is always valid', () => {
    const tool = new SelfUpdateTool(makeConfig());
    expect(tool.validateToolParams({ action: 'restart_only' })).toBeNull();
  });

  it('description mentions update/restart', () => {
    const tool = new SelfUpdateTool(makeConfig());
    expect(tool.getDescription({}).toLowerCase()).toMatch(/updat|restart|重启|更新/);
  });
});
