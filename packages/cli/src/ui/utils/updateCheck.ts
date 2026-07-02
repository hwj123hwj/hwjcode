/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getPackageJson } from '../../utils/package.js';
import { getCliVersion } from '../../utils/version.js';
import { t, tp, isChineseLocale } from './i18n.js';
import semver from 'semver';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 服务器地址配置 - 动态获取以确保环境变量正确加载
function getServerUrl(): string {
  // 开发环境下默认使用本地服务器
  if (process.env.DEV === 'true' || process.env.NODE_ENV === 'development') {
    return process.env.DEEPX_SERVER_URL || 'http://localhost:6699';
  }

  return process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai';
}

interface UpdateCheckResponse {
  success: boolean;
  hasUpdate: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updateCommand?: string;
  downloadUrl?: string;
  forceUpdate?: boolean;
  message?: string;
}

interface UpdateCheckCache {
  lastCheckTime: number;
  lastResult: string | null;
  version: string;
}

// 获取缓存文件路径
function getCacheFilePath(): string {
  const settingsDir = join(homedir(), '.easycode-user');
  return join(settingsDir, 'update-check.json');
}

// 读取缓存
async function readUpdateCheckCache(): Promise<UpdateCheckCache | null> {
  try {
    const cacheFile = getCacheFilePath();
    const content = await fs.readFile(cacheFile, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

// 写入缓存
async function writeUpdateCheckCache(cache: UpdateCheckCache): Promise<void> {
  try {
    const cacheFile = getCacheFilePath();
    const settingsDir = join(homedir(), '.easycode-user');

    // 确保目录存在
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn(tp('update.cache.write.error', { error: error instanceof Error ? error.message : String(error) }));
  }
}

// 格式化时间显示
function formatNextCheckTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  const locale = isChineseLocale() ? 'zh-CN' : 'en-US';
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  if (date.toDateString() === now.toDateString()) {
    return tp('update.time.today', { time });
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) {
    return tp('update.time.tomorrow', { time });
  }

  return date.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 判断 latestVersion 是否比 currentVersion 更新。
 * 使用 semver 进行语义化版本比较；当任一版本号无法被 semver 解析时，
 * 回退为信任服务器（返回 true），以兼容非标准版本号场景。
 */
function isNewerVersion(
  currentVersion: string,
  latestVersion: string | undefined,
): boolean {
  if (!latestVersion) {
    return false;
  }

  const current = semver.coerce(currentVersion);
  const latest = semver.coerce(latestVersion);

  // 无法解析为标准 semver 时，回退信任服务器的 hasUpdate 判断
  if (!current || !latest) {
    return true;
  }

  return semver.gt(latest, current);
}

export async function checkForUpdates(
  showProgress: boolean = false,
  forceCheck: boolean = false
): Promise<string | null> {
  try {
    // Skip update check when running from source (development mode) unless forced
    if (process.env.DEV === 'true' && !forceCheck) {
      if (showProgress) {
      }
      return null;
    }

    const packageJson = await getPackageJson();
    if (!packageJson || !packageJson.name || !packageJson.version) {
      return null;
    }

    // 统一版本来源：优先使用 CI 构建期注入的 CLI_VERSION（发版流程会用 git tag
    // 覆写为真实版本号），而非 package.json 里可能滞后的占位版本号。
    // 这与 footer / --version 的取值口径（getCliVersion）保持一致，避免出现
    // “footer 显示 1.1.36 但更新检查仍按 1.1.14 上报”导致的误报升级。
    const currentVersion = await getCliVersion();

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000; // 24小时

    // 检查缓存（非强制模式）
    if (!forceCheck) {
      const cache = await readUpdateCheckCache();

      if (cache && cache.version === currentVersion) {
        const timeSinceLastCheck = now - cache.lastCheckTime;

        if (timeSinceLastCheck < oneDayMs) {
          // 缓存有效，静默返回
          return cache.lastResult;
        }
      }
    }

    // ─── 直接查询 npm registry（而非公司后端） ────────────────────────────
    // 本项目是公司 CLI 的独立 fork（npm 包名可能与公司产品不同），
    // 公司后端 api-code.deepvlab.ai 返回的是公司产品版本号，与本 fork 不一致。
    // 因此直接查询 npm registry 获取真实 latest 版本号。
    const npmRegistryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageJson.name)}/latest`;
    const updateCommand = `npm install -g ${packageJson.name}@latest`;

    const response = await fetch(
      npmRegistryUrl,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': `${packageJson.name}/${currentVersion}`,
        },
        signal: AbortSignal.timeout(10000), // 10秒超时
      }
    );

    if (!response.ok) {
      const message = tp('update.check.failed.http', { status: response.status });
      console.warn(message);
      if (showProgress) {
        console.warn(`[update-check] npm registry -> ${response.status} ${response.statusText}`);
      }
      return null;
    }

    const npmData = await response.json() as { version?: string };
    const latestVersion = npmData.version;
    if (!latestVersion) {
      console.warn('[update-check] npm registry response missing version field');
      return null;
    }

    let result: string | null = null;
    const MESSAGE_SEPARATOR = '::MSG::';

    // 客户端二次校验版本号：仅当 npm latest 严格大于当前版本时，才提示更新。
    const hasRealUpdate = isNewerVersion(currentVersion, latestVersion);

    if (hasRealUpdate) {
      // fork 项目：所有 npm 更新都视为强制更新，确保运行实例始终最新
      result = `FORCE_UPDATE:${latestVersion}:${updateCommand}${MESSAGE_SEPARATOR}${t('update.force.message.header')}
${tp('update.version.line', { current: currentVersion, latest: latestVersion })}
${tp('update.command.line', { command: updateCommand })}

${t('update.after.success.exit')}`;
    }

    // 保存缓存（非强制检查时）
    if (!forceCheck) {
      const cache: UpdateCheckCache = {
        lastCheckTime: now,
        lastResult: result,
        version: currentVersion
      };
      await writeUpdateCheckCache(cache);
    }

    return result;
  } catch (e) {
    // 网络错误或其他错误时静默失败，不影响正常使用
    const message = tp('update.check.failed.generic', { error: String(e) });
    console.warn(message);
    return null;
  }
}

// 内部使用的命令执行辅助函数
async function runSingleCommand(commandStr: string): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    const parts = commandStr.trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    const isWindows = process.platform === 'win32';
    const actualCommand = isWindows ? 'cmd.exe' : command;
    const actualArgs = isWindows ? ['/c', command, ...args] : args;

    const proc = spawn(actualCommand, actualArgs, {
      stdio: 'inherit',
      shell: false
    });

    proc.on('close', (code) => {
      resolve({ code });
    });

    proc.on('error', (error) => {
      resolve({ code: null, error });
    });
  });
}

// 执行自动更新命令
export async function executeUpdateCommand(updateCommand: string): Promise<boolean> {
  console.log(t('update.auto.exec.start'));
  console.log(tp('update.command.line', { command: updateCommand }));

  const result = await runSingleCommand(updateCommand);

  if (result.code === 0) {
    console.log(t('update.completed'));
    return true;
  }

  // 检查是否为全局 npm 安装包命令
  const isNpmGlobalInstall = updateCommand.includes('npm install -g') || updateCommand.includes('npm i -g');
  if (isNpmGlobalInstall) {
    const isZH = isChineseLocale();
    console.log(isZH
      ? '\n⚠️ 检测到更新失败，可能是由于原全局文件被占用（如 ENOTEMPTY/EPERM 错误）。\n正在尝试通过“先安全卸载旧版本，再重新安装”的 Fallback 重试策略...'
      : '\n⚠️ Update failed, possibly due to locked/busy global files (e.g., ENOTEMPTY/EPERM error).\nAttempting fallback strategy: "safely uninstall old version first, then reinstall"...'
    );

    // 提取包名（例如从 "npm install -g deepv-code" 提取 "deepv-code"）
    let packageName = 'deepv-code';
    const match = updateCommand.match(/(?:npm\s+(?:install|i)\s+-g\s+|npm\s+-g\s+(?:install|i)\s+)([^\s@]+)/);
    if (match && match[1]) {
      packageName = match[1];
    }

    const uninstallCommand = `npm uninstall -g ${packageName}`;
    console.log(isZH
      ? `正在执行卸载命令：${uninstallCommand}`
      : `Executing uninstall command: ${uninstallCommand}`
    );

    const uninstallResult = await runSingleCommand(uninstallCommand);
    if (uninstallResult.code === 0) {
      console.log(isZH
        ? '卸载成功！正在重新执行安装...'
        : 'Uninstall succeeded! Re-executing install command...'
      );

      const reinstallResult = await runSingleCommand(updateCommand);
      if (reinstallResult.code === 0) {
        console.log(t('update.completed'));
        return true;
      }
    } else {
      console.warn(isZH
        ? '⚠️ 卸载失败，正在尝试使用 --force 参数强制覆盖安装...'
        : '⚠️ Uninstall failed, attempting to force install with --force flag...'
      );

      const forceInstallCommand = `${updateCommand} --force`;
      console.log(isZH
        ? `正在执行强制安装命令：${forceInstallCommand}`
        : `Executing force install command: ${forceInstallCommand}`
      );

      const forceResult = await runSingleCommand(forceInstallCommand);
      if (forceResult.code === 0) {
        console.log(t('update.completed'));
        return true;
      }
    }
  }

  if (result.error) {
    console.error(tp('update.exec.command.error', { error: result.error.message }));
  } else {
    console.error(tp('update.failed.code', { code: String(result.code) }));
  }

  const isZH = isChineseLocale();
  const cleanPackageName = updateCommand.includes('deepv-code') ? 'deepv-code' : 'deepv-code-cli';

  console.error(isZH
    ? `\n❌ 自动更新失败。您可以尝试手动执行以下命令进行安全更新：\n👉 npm uninstall -g ${cleanPackageName} && npm install -g ${cleanPackageName}\n`
    : `\n❌ Automatic update failed. You can try manually executing the following command for a safe update:\n👉 npm uninstall -g ${cleanPackageName} && npm install -g ${cleanPackageName}\n`
  );

  return false;
}
