/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Config } from '../config/config.js';

/**
 * 新品牌 npm 包名与全局命令名。
 * 自更新固定从 npm 拉取 latest，并以飞书常驻模式重新拉起。
 */
export const SELF_UPDATE_PACKAGE = 'easycode-ai';
export const SELF_UPDATE_RELAUNCH_COMMAND = 'easycode';
export const SELF_UPDATE_RELAUNCH_ARGS = ['--feishu'];

/**
 * 安装模式（三选一）：
 *  - none：仅重启，不安装任何东西（用于 /feishu restart 热重启救卡死）
 *  - npm：全局安装 <packageName>@latest
 *  - tgz：全局安装一个本地 .tgz 绝对路径
 */
export type RelaunchInstallMode =
  | { type: 'none' }
  | { type: 'npm'; packageName: string }
  | { type: 'tgz'; path: string };

export interface BuildRelaunchScriptOptions {
  /** 父 CLI 进程 PID —— 外挂会轮询它消失后再操作，避免文件占用。 */
  parentPid: number;
  /** 安装模式。 */
  install: RelaunchInstallMode;
  /** 重新拉起的命令（全局 bin 名）。仅在未提供 node 绝对路径时作为回退使用。 */
  relaunchCommand: string;
  /** 重新拉起的参数。 */
  relaunchArgs: string[];
  /** 外挂脚本自身的绝对路径（用于结束时自删）。 */
  scriptPath: string;
  /**
   * node 可执行文件的绝对路径（通常为 process.execPath）。
   * 提供后将以 `<node> <entryScript> <args...>` 自举重启，彻底绕开 PATH/nvm/homebrew 查找。
   */
  relaunchNodePath?: string;
  /**
   * CLI 入口脚本的绝对路径（通常为 process.argv[1]）。
   * 与 relaunchNodePath 配套使用：当前进程正是由这两者启动的，复用它们即可精确复刻启动方式。
   */
  relaunchEntryScript?: string;
  /** 重启日志路径。提供后 relaunch 的 stdout/stderr 会重定向到此文件，便于排障。 */
  logPath?: string;
}

/**
 * 生成跨平台的"重启外挂"脚本内容（纯 JS，无 OS 分支、无需执行权限）。
 *
 * 外挂生命周期：
 *   1) 轮询父 PID，直到父进程退出（process.kill(pid, 0) 抛 ESRCH 即已退出）
 *   2) 按 install 模式安装（none 跳过 / npm latest / 本地 tgz）
 *   3) detached + unref 拉起新进程，脱离本外挂生命周期
 *   4) 删除自身临时脚本
 *
 * 重启目标的两种模式：
 *   - 绝对路径自举（推荐）：提供 relaunchNodePath + relaunchEntryScript 时，
 *     以 `spawn(<node>, [<entryScript>, ...args], { detached })` 启动，**不使用 shell**。
 *     当前进程正是由这两个绝对路径启动的，因此一定有效，彻底免疫 nvm / Homebrew /
 *     非交互 shell 不加载 .bashrc 导致的 PATH 缺失（Ubuntu/macOS 重启失败的根因）。
 *   - 命令回退：未提供绝对路径时，退回 `spawn(<command>, args, { shell:true })`。
 *
 * 同一套脚本被 SelfUpdateTool（更新+重启 / 仅重启）与 /feishu restart 共用。
 * 纯函数，只产字符串，便于单测。
 */
export function buildRelaunchScript(opts: BuildRelaunchScriptOptions): string {
  const {
    parentPid,
    install,
    relaunchCommand,
    relaunchArgs,
    scriptPath,
    relaunchNodePath,
    relaunchEntryScript,
    logPath,
  } = opts;

  const PARENT_PID = JSON.stringify(parentPid);
  const RELAUNCH_CMD = JSON.stringify(relaunchCommand);
  const RELAUNCH_ARGS = JSON.stringify(relaunchArgs);
  const SCRIPT_PATH = JSON.stringify(scriptPath);
  const NODE_PATH = JSON.stringify(relaunchNodePath ?? null);
  const ENTRY_SCRIPT = JSON.stringify(relaunchEntryScript ?? null);
  const LOG_PATH = JSON.stringify(logPath ?? null);

  // 依据安装模式，生成 npm install 的参数数组（或空表示跳过）。
  // 用 JSON 内联，自动处理路径中的空格/反斜杠/引号，杜绝注入。
  let INSTALL_ARGS = 'null';
  if (install.type === 'npm') {
    INSTALL_ARGS = JSON.stringify(['install', '-g', `${install.packageName}@latest`]);
  } else if (install.type === 'tgz') {
    INSTALL_ARGS = JSON.stringify(['install', '-g', install.path]);
  }

  return `'use strict';
// Easy Code relaunch helper (auto-generated, cross-platform, single code path).
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');

const PARENT_PID = ${PARENT_PID};
const INSTALL_ARGS = ${INSTALL_ARGS}; // null = skip install (restart only)
const RELAUNCH_CMD = ${RELAUNCH_CMD};
const RELAUNCH_ARGS = ${RELAUNCH_ARGS};
const SCRIPT_PATH = ${SCRIPT_PATH};
const NODE_PATH = ${NODE_PATH};       // absolute node path; null = fall back to command lookup
const ENTRY_SCRIPT = ${ENTRY_SCRIPT}; // absolute CLI entry script; null = fall back to command lookup
const LOG_PATH = ${LOG_PATH};         // relaunch log file; null = ignore output

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0：只探测存活，不发信号
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // 存在但无权限，仍算存活
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(LOG_PATH, '[' + new Date().toISOString() + '] ' + msg + '\\n');
  } catch (_) { /* logging is best-effort */ }
}

function cleanupSelf() {
  try {
    fs.unlinkSync(SCRIPT_PATH);
  } catch (_) {
    // 删除失败无妨，临时目录最终会被系统清理
  }
}

async function main() {
  // 1) 轮询父进程退出（最多 ~30s，超时也继续，避免卡死）
  const deadline = Date.now() + 30000;
  while (isAlive(PARENT_PID) && Date.now() < deadline) {
    await sleep(300);
  }

  // 2) 按需安装（INSTALL_ARGS 为 null 时跳过 = 仅重启）
  if (INSTALL_ARGS) {
    log('Installing: npm ' + INSTALL_ARGS.join(' '));
    const install = spawnSync('npm', INSTALL_ARGS, { stdio: 'ignore', shell: true });
    if (install.status !== 0) {
      // 安装失败：不拉起旧版本，清理后退出，避免误导。
      log('Install failed with status ' + install.status);
      cleanupSelf();
      process.exit(install.status || 1);
    }
  }

  // 3) 准备 stdio：有日志路径则重定向 stdout/stderr 到日志文件，否则 ignore。
  let stdio = 'ignore';
  if (LOG_PATH) {
    try {
      const fd = fs.openSync(LOG_PATH, 'a');
      stdio = ['ignore', fd, fd];
    } catch (_) {
      stdio = 'ignore';
    }
  }

  // 4) detached 拉起新进程，脱离本外挂生命周期。
  //    优先用 node 绝对路径 + 入口脚本自举（免疫 PATH/nvm/homebrew 问题，不用 shell）；
  //    否则回退到命令查找（shell:true）。
  let child;
  if (NODE_PATH && ENTRY_SCRIPT) {
    log('Relaunch (absolute): ' + NODE_PATH + ' ' + ENTRY_SCRIPT + ' ' + RELAUNCH_ARGS.join(' '));
    child = spawn(NODE_PATH, [ENTRY_SCRIPT].concat(RELAUNCH_ARGS), {
      detached: true,
      stdio: stdio,
    });
  } else {
    log('Relaunch (command): ' + RELAUNCH_CMD + ' ' + RELAUNCH_ARGS.join(' '));
    child = spawn(RELAUNCH_CMD, RELAUNCH_ARGS, {
      detached: true,
      stdio: stdio,
      shell: true,
    });
  }

  // 关键：监听 spawn 失败事件，避免错误被静默吞掉（Ubuntu/macOS 重启失败时一无所知的根因）。
  child.on('error', (err) => {
    log('Relaunch spawn error: ' + (err && err.message ? err.message : String(err)));
    cleanupSelf();
    process.exit(1);
  });

  child.unref();

  // 5) 自清理并退出。
  cleanupSelf();
  process.exit(0);
}

main();
`;
}

/**
 * 写出外挂脚本并以 detached 子进程启动它（不退出当前进程）。
 *
 * 这是 SelfUpdateTool 与 /feishu restart 共用的底层动作：调用方负责在此之后
 * 安排当前进程退出（外挂会轮询父 PID 消失后接管）。
 *
 * 重启目标采用"绝对路径自举"：用当前进程的 process.execPath（node 绝对路径）
 * 与 process.argv[1]（CLI 入口脚本绝对路径）精确复刻当前启动方式，彻底绕开
 * nvm / Homebrew / 非交互 shell 不加载 .bashrc 导致的 PATH 缺失问题。
 *
 * @returns 写出的脚本路径
 */
export function launchRelaunchHelper(install: RelaunchInstallMode): string {
  const parentPid = process.pid;
  const scriptPath = join(
    tmpdir(),
    `easycode-relaunch-${parentPid}-${Date.now()}.js`,
  );

  // 重启日志固定写到全局配置目录，便于排障（Ubuntu/macOS 重启失败时可查）。
  let logPath: string | undefined;
  try {
    const logDir = join(homedir(), '.easycode-user');
    mkdirSync(logDir, { recursive: true });
    logPath = join(logDir, 'relaunch.log');
  } catch {
    logPath = undefined; // 日志是 best-effort，失败不阻断重启
  }

  // 当前进程的绝对启动信息：node 路径 + 入口脚本。
  // process.argv[1] 在常规启动下一定存在；缺失时回退到命令查找模式。
  const relaunchNodePath = process.execPath;
  const relaunchEntryScript = process.argv[1] || undefined;

  const scriptContent = buildRelaunchScript({
    parentPid,
    install,
    relaunchCommand: SELF_UPDATE_RELAUNCH_COMMAND,
    relaunchArgs: SELF_UPDATE_RELAUNCH_ARGS,
    scriptPath,
    relaunchNodePath,
    relaunchEntryScript,
    logPath,
  });

  writeFileSync(scriptPath, scriptContent, 'utf8');

  // 用当前 node 可执行文件跑外挂（process.execPath 一定存在、跨平台）。
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return scriptPath;
}

/** action：更新并重启 / 仅重启。 */
export type SelfUpdateAction = 'update_and_restart' | 'restart_only';
/** source：npm latest / 本地 tgz。 */
export type SelfUpdateSource = 'npm' | 'local';

/**
 * Params for SelfUpdateTool. 全部可选 —— 模型零参调用 = npm latest 更新并重启。
 */
export interface SelfUpdateParams {
  /** 'update_and_restart'（默认）或 'restart_only'（仅重启进程，救卡死/换配置）。 */
  action?: SelfUpdateAction;
  /** 更新源：'npm'（默认，装 latest）或 'local'（装本地 tgz，需 sourcePath）。 */
  source?: SelfUpdateSource;
  /** 当 source='local' 时，本地 .tgz 的绝对路径。 */
  sourcePath?: string;
  /** 可选：触发原因（仅日志）。 */
  reason?: string;
}

/**
 * SelfUpdateTool — 仅在飞书常驻模式下动态注册。
 *
 * 用法（全暴露给模型，模型拿不准就问用户，由用户用自然语言指示）：
 *   - 默认：从 npm 安装 easycode-ai@latest 并重启
 *   - action='restart_only'：不安装，仅重启当前进程（救卡死 / 应用新配置）
 *   - source='local' + sourcePath=<abs .tgz>：安装某个本地 tgz 包并重启
 *
 * 进程不能自杀续命，故 spawn 一个 detached 的纯 JS 外挂接力（见
 * buildRelaunchScript / launchRelaunchHelper）。
 */
export class SelfUpdateTool extends BaseTool<SelfUpdateParams, ToolResult> {
  static readonly Name: string = 'self_update';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly config: Config) {
    super(
      SelfUpdateTool.Name,
      'SelfUpdate',
      'Updates and/or restarts Easy Code (Feishu/Lark gateway mode only). Use ONLY when the user ' +
        'explicitly asks to update/upgrade or restart Easy Code.\n' +
        'Parameters:\n' +
        '- action: "update_and_restart" (default) installs a new version then restarts; ' +
        '"restart_only" just restarts the current process WITHOUT installing (use to recover a stuck ' +
        'session or apply changed config).\n' +
        '- source: "npm" (default) installs easycode-ai@latest from npm; "local" installs a local .tgz ' +
        '(requires sourcePath).\n' +
        '- sourcePath: absolute path to a local .tgz, required when source="local".\n' +
        'A detached cross-platform helper performs the work after this process exits, then relaunches ' +
        '`easycode --feishu` automatically. The bot is briefly offline (tens of seconds) and returns by ' +
        'itself; Feishu credentials are stored globally so no re-login is needed. If unsure which mode the ' +
        'user wants, ASK them first.',
      Icon.Hammer,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            enum: ['update_and_restart', 'restart_only'],
            description:
              'update_and_restart (default) = install then restart; restart_only = just restart, no install.',
          },
          source: {
            type: Type.STRING,
            enum: ['npm', 'local'],
            description:
              'npm (default) = install easycode-ai@latest; local = install a local .tgz (needs sourcePath). Ignored when action=restart_only.',
          },
          sourcePath: {
            type: Type.STRING,
            description:
              'Absolute path to a local .tgz package. Required when source="local".',
          },
          reason: {
            type: Type.STRING,
            description: 'Optional short note about why (for logging).',
          },
        },
        required: [],
      },
    );
  }

  validateToolParams(params: SelfUpdateParams): string | null {
    if (
      params.action !== undefined &&
      params.action !== 'update_and_restart' &&
      params.action !== 'restart_only'
    ) {
      return `Invalid action "${params.action}". Must be "update_and_restart" or "restart_only".`;
    }
    if (
      params.source !== undefined &&
      params.source !== 'npm' &&
      params.source !== 'local'
    ) {
      return `Invalid source "${params.source}". Must be "npm" or "local".`;
    }
    // 仅当真的要安装（非 restart_only）且 source=local 时，才强制要求 sourcePath。
    const isRestartOnly = params.action === 'restart_only';
    if (!isRestartOnly && params.source === 'local') {
      if (!params.sourcePath || params.sourcePath.trim() === '') {
        return 'source="local" requires "sourcePath" (absolute path to a .tgz file).';
      }
    }
    return null;
  }

  getDescription(params: SelfUpdateParams): string {
    if (params.action === 'restart_only') return 'Restart Easy Code (Feishu mode)';
    if (params.source === 'local') {
      return `Install local package and restart: ${params.sourcePath ?? '(missing path)'}`;
    }
    return 'Update Easy Code to latest and restart (Feishu mode)';
  }

  /** 把参数解析为底层安装模式。 */
  private resolveInstallMode(params: SelfUpdateParams): RelaunchInstallMode {
    if (params.action === 'restart_only') {
      return { type: 'none' };
    }
    if (params.source === 'local' && params.sourcePath) {
      return { type: 'tgz', path: params.sourcePath };
    }
    return { type: 'npm', packageName: SELF_UPDATE_PACKAGE };
  }

  async execute(
    params: SelfUpdateParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Self-update input error: ${validationError}`,
        returnDisplay: `❌ 自更新参数错误：${validationError}`,
      };
    }

    const install = this.resolveInstallMode(params);

    try {
      launchRelaunchHelper(install);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        llmContent: `Self-update failed: cannot start relaunch helper: ${msg}`,
        returnDisplay: `❌ 自更新失败：无法启动重启进程 (${msg})`,
      };
    }

    // 安排当前进程退出。延迟一小段时间，给飞书侧机会把本次结果回传给用户。
    const SHUTDOWN_DELAY_MS = 1500;
    setTimeout(() => {
      process.exit(0);
    }, SHUTDOWN_DELAY_MS).unref?.();

    const actionText =
      install.type === 'none'
        ? 'restart (no install)'
        : install.type === 'tgz'
          ? `install local package "${install.path}" then restart`
          : `install ${SELF_UPDATE_PACKAGE}@latest then restart`;

    const displayText =
      install.type === 'none'
        ? '🔄 正在热重启，稍候我就回来。'
        : install.type === 'tgz'
          ? `🔄 正在安装本地包并重启：${install.path}，稍候我就回来。`
          : '🔄 正在安装最新版并重启，稍候我就回来。';

    return {
      llmContent:
        `Self-update started: will ${actionText} via a detached helper after this process exits, ` +
        'then relaunch `easycode --feishu`. The bot will be briefly offline and return automatically. ' +
        'Tell the user it is in progress and will be back shortly.',
      returnDisplay: displayText,
      summary: 'Self-update / restart triggered',
    };
  }
}
