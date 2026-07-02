/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git Worktree 并行工作区隔离 —— 核心管理器。
 *
 * 设计文档：docs/worktree-parallel-workspace-design.md
 *
 * 让多个 sub-agent / 远程 session 在独立的 git worktree 中并行开发，
 * 互不干扰。每个 worktree 拥有独立的物理目录和独立分支。
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { findGitRoot, isGitRepository } from './gitUtils.js';

/** worktree 元信息。 */
export interface WorktreeInfo {
  /** 唯一名称（slug），如 "fix-auth-bug"。 */
  name: string;
  /** 分支名，如 "easycode/fix-auth-bug"。 */
  branch: string;
  /** worktree 绝对路径（canonical，已解析 symlink）。 */
  directory: string;
}

/** 创建 worktree 的选项。 */
export interface WorktreeCreateOptions {
  /** 可读名称，用于生成 branch 和目录名。不提供则用随机 slug。 */
  name?: string;
  /** 创建 worktree 的基准引用，默认 HEAD。 */
  baseRef?: string;
  /** 创建 worktree 后执行的初始化命令（如 "npm install"）。 */
  startCommand?: string;
  /** 是否异步执行 boot（checkout + startCommand），默认 true。 */
  asyncBoot?: boolean;
}

/** commitAndCleanup 的返回结果。 */
export interface WorktreeCleanupResult {
  success: boolean;
  /** 是否实际产生了 commit（false = pristine，无改动）。 */
  committed: boolean;
  /** 如果 committed，返回提交所在分支名。 */
  branchName?: string;
  /** 提交 SHA。 */
  commitSha?: string;
  error?: string;
}

/** 分支名前缀。 */
const BRANCH_PREFIX = 'easycode/';

/** worktree 存放目录（项目内）。 */
const WORKTREES_DIR_NAME = 'worktrees';

/** .easycode 项目数据目录名。 */
const EASYCODE_DIR = '.easycode';

/** slug 冲突时的最大重试次数。 */
const MAX_SLUG_RETRIES = 26;

/** 并发锁 Map 的最大条目数（LRU 淘汰）。 */
const MAX_LOCK_ENTRIES = 64;

// ─── 并发锁（per git root） ───────────────────────────────────────────────────

interface LockEntry {
  promise: Promise<void>;
  count: number;
}

const locks = new Map<string, LockEntry>();

/**
 * 获取基于 git root 的 Promise 队列锁。
 * 同一 git root 上的 worktree 操作会被串行化，避免 `.git/worktrees` 元数据竞争。
 * 带 LRU 淘汰（超过上限时清理 count === 0 的空闲条目）。
 *
 * 实现要点（async mutex 链式模式）：
 *   - 必须先捕获 `prev = entry.promise`（上一位持有者的释放 promise），
 *   - 再把 `entry.promise` 更新为新的链式 promise（prev 解除后才轮到我），
 *   - 然后 `await prev`（等待上一位释放），**不能 await entry.promise**（否则会
 *     等待自己的 release → 自死锁）。
 */
async function acquireLock(gitRoot: string): Promise<() => void> {
  const key = canonical(gitRoot);

  let entry = locks.get(key);
  if (!entry) {
    entry = { promise: Promise.resolve(), count: 0 };
    locks.set(key, entry);
  }

  // LRU 淘汰：超过上限时清理空闲条目
  if (locks.size > MAX_LOCK_ENTRIES) {
    for (const [k, v] of locks) {
      if (v.count === 0 && k !== key) locks.delete(k);
    }
  }

  // 捕获上一位的 promise，再创建本位的释放 promise
  const prev = entry.promise;
  let release!: () => void;
  const myTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 更新链尾：prev 解除后才开始 myTurn
  entry.promise = prev.then(() => myTurn);
  entry.count++;

  // 等待上一位释放（不能等自己的 myTurn）
  await prev;

  return () => {
    entry!.count--;
    release();
  };
}

// ─── 路径归一化 ──────────────────────────────────────────────────────────────

/**
 * 路径归一化：realPath（解析 symlink）+ normalize + Windows 小写化。
 * 所有路径比较都应使用 canonical path，避免符号链接误判。
 */
export function canonical(input: string): string {
  try {
    let resolved = input;
    try {
      resolved = fs.realpathSync(input);
    } catch {
      // 路径可能尚不存在（如准备创建的 worktree 目录），退而用 path.resolve
      resolved = path.resolve(input);
    }
    resolved = path.normalize(resolved);
    // Windows 盘符与路径大小写不敏感
    if (process.platform === 'win32') {
      resolved = resolved.toLowerCase();
    }
    return resolved;
  } catch {
    return path.normalize(path.resolve(input));
  }
}

// ─── slugify ─────────────────────────────────────────────────────────────────

/**
 * slugify 规则（参考 MiMo-Code）：
 * - 小写化
 * - `[^a-z0-9]+` → `-`
 * - 去首尾 `-`
 * - slug 为空时（如纯中文/特殊字符）由调用方 fallback 到随机 slug
 *
 * 注意：`[^a-z0-9]+` 会吃掉所有非 ASCII 字符（含中文、emoji）。
 * 分支名含非 ASCII 可能在某些 git hooks / CI 中引发问题，暂维持 ASCII-only。
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

/** 生成 4 位随机十六进制后缀。 */
function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 6);
}

/** slug 为空时的随机 fallback（4 位随机名，如 "a3f2"）。 */
function randomSlug(): string {
  return randomSuffix() + randomSuffix().slice(0, 2);
}

// ─── git 命令执行封装 ─────────────────────────────────────────────────────────

/**
 * 执行 git 命令。返回 { ok, stdout, stderr }。
 * 不抛错，由调用方根据 ok 判断。
 */
export function execGit(
  args: string[],
  cwd: string,
  timeoutMs: number = 60000,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ ok: false, stdout, stderr: stderr + '\n[timeout]', code: null });
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: String(err), code: null });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), code });
      }
    });
  });
}

// ─── WorktreeManager ─────────────────────────────────────────────────────────

/**
 * Git Worktree 生命周期管理器。
 *
 * 用法：
 * ```typescript
 * const wm = new WorktreeManager(projectRoot);
 * const info = await wm.create({ name: 'fix-bug' });
 * // ... agent 在 info.directory 中工作 ...
 * await wm.commitAndCleanup(info, 'fix: bug');
 * ```
 */
export class WorktreeManager {
  /**
   * @param projectRoot 主 workspace 根目录。默认取 process.cwd()。
   */
  constructor(private readonly projectRoot: string = process.cwd()) {}

  // ── 静态工具方法 ──

  /** 检查是否在 git 仓库中。 */
  static isGitRepo(directory: string = process.cwd()): boolean {
    return isGitRepository(directory);
  }

  /** 获取 worktree 存储根目录：`<projectRoot>/.easycode/worktrees`。 */
  static getWorktreesRoot(projectRoot: string = process.cwd()): string {
    return path.join(projectRoot, EASYCODE_DIR, WORKTREES_DIR_NAME);
  }

  // ── 实例方法 ──

  /** 当前项目是否为 git 仓库。 */
  isGitRepo(): boolean {
    return WorktreeManager.isGitRepo(this.projectRoot);
  }

  /** 当前项目的 git root。 */
  getGitRoot(): string | null {
    return findGitRoot(this.projectRoot);
  }

  /** 当前项目的 worktree 存储根目录。 */
  getWorktreesRoot(): string {
    return WorktreeManager.getWorktreesRoot(this.projectRoot);
  }

  /**
   * 创建一个 worktree。
   *
   * 流程：
   * 1. 检查是否在 git 仓库
   * 2. slugify(name)，空则随机
   * 3. 分支/目录冲突时追加随机后缀重试（最多 26 次）
   * 4. 确保 `.easycode/worktrees/` 被 .gitignore 忽略
   * 5. 加锁 → `git worktree add --no-checkout -b <branch> <dir>` → 释放锁
   * 6. `git reset --hard` 填充文件
   * 7. asyncBoot=true 时 fork startCommand 到后台
   */
  async create(options?: WorktreeCreateOptions): Promise<WorktreeInfo> {
    if (!this.isGitRepo()) {
      throw new WorktreeError(
        'NOT_A_GIT_REPO',
        `Not a git repository: ${this.projectRoot}`,
      );
    }

    const gitRoot = this.getGitRoot();
    if (!gitRoot) {
      throw new WorktreeError('NO_GIT_ROOT', 'Cannot determine git root directory.');
    }

    const baseRef = options?.baseRef ?? 'HEAD';
    const asyncBoot = options?.asyncBoot ?? true;

    // slug 生成与冲突重试
    const baseName = options?.name?.trim() || '';
    let slug = slugify(baseName);
    if (!slug) slug = randomSlug();

    let directory = '';
    let branch = '';
    for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
      const candidate = attempt === 0 ? slug : `${slug}-${randomSuffix()}`;
      branch = `${BRANCH_PREFIX}${candidate}`;
      directory = canonical(path.join(this.getWorktreesRoot(), candidate));

      if (fs.existsSync(directory)) {
        continue; // 目录已存在，换名重试
      }
      // 检查分支是否已存在
      const refCheck = await execGit(
        ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        gitRoot,
      );
      if (refCheck.ok) {
        continue; // 分支已存在，换名重试
      }
      slug = candidate;
      break;
    }

    if (!directory || !branch) {
      throw new WorktreeError(
        'SLUG_CONFLICT',
        `Could not find an available worktree name after ${MAX_SLUG_RETRIES} attempts.`,
      );
    }

    // 确保 .easycode/worktrees/ 被 gitignore
    await this.ensureGitignored(gitRoot);

    // 加锁创建
    const release = await acquireLock(gitRoot);
    try {
      // --no-checkout 避免大仓库慢速初始 checkout；之后用 reset --hard 填充
      const addResult = await execGit(
        ['worktree', 'add', '--no-checkout', '-b', branch, directory, baseRef],
        gitRoot,
      );
      if (!addResult.ok) {
        throw new WorktreeError(
          'WORKTREE_ADD_FAILED',
          `git worktree add failed: ${addResult.stderr || addResult.stdout}`,
        );
      }
    } finally {
      release();
    }

    // 填充文件（worktree 内执行）
    const resetResult = await execGit(['reset', '--hard'], directory);
    if (!resetResult.ok) {
      // 尽力清理
      await this.cleanupByDir(directory, branch).catch(() => {});
      throw new WorktreeError(
        'WORKTREE_CHECKOUT_FAILED',
        `git reset --hard failed in worktree: ${resetResult.stderr}`,
      );
    }

    // startCommand
    if (options?.startCommand) {
      if (asyncBoot) {
        this.forkStartCommand(options.startCommand, directory);
      } else {
        await this.runStartCommand(options.startCommand, directory);
      }
    }

    return { name: slug, branch, directory };
  }

  /**
   * 提交修改并清理 worktree。
   * - 先用 isPristine 检查，无改动则跳过 commit 直接 cleanup（committed: false）。
   * - 有改动才 git add -A + commit。
   */
  async commitAndCleanup(
    info: WorktreeInfo,
    commitMessage?: string,
  ): Promise<WorktreeCleanupResult> {
    try {
      const gitRoot = this.getGitRoot();
      if (!gitRoot) {
        return { success: false, committed: false, error: 'No git root.' };
      }

      let committed = false;
      let commitSha: string | undefined;

      // 检查是否有改动
      const pristine = await this.isPristine(info.directory);
      if (!pristine) {
        const msg =
          commitMessage ??
          `easycode: changes from worktree ${info.name}`;
        const addResult = await execGit(['add', '-A'], info.directory);
        if (!addResult.ok) {
          return {
            success: false,
            committed: false,
            error: `git add failed: ${addResult.stderr}`,
          };
        }
        // 不使用 --allow-empty：如果没有实际变更（仅靠 status 判断不准），commit 会失败，我们降级为 cleanup
        const commitResult = await execGit(
          ['commit', '-m', msg, '--no-verify'],
          info.directory,
        );
        if (commitResult.ok) {
          committed = true;
          const shaResult = await execGit(['rev-parse', 'HEAD'], info.directory);
          commitSha = shaResult.ok ? shaResult.stdout : undefined;
        } else {
          // 可能是 add -A 后仍无实际变更（如仅 stat 变化），视为无改动
          const stillDirty = await execGit(['status', '--porcelain'], info.directory);
          if (stillDirty.ok && stillDirty.stdout.trim()) {
            // 确实有改动但 commit 失败
            return {
              success: false,
              committed: false,
              error: `git commit failed: ${commitResult.stderr}`,
            };
          }
        }
      }

      // 清理 worktree（有改动保留分支，无改动删除分支）
      await this.cleanupByDir(info.directory, info.branch, !committed);

      return {
        success: true,
        committed,
        branchName: committed ? info.branch : undefined,
        commitSha,
      };
    } catch (err) {
      return {
        success: false,
        committed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 仅清理（不提交，丢弃修改）。
   */
  async cleanup(info: WorktreeInfo): Promise<void> {
    await this.cleanupByDir(info.directory, info.branch, true);
  }

  /**
   * 列出当前项目的所有 worktree。
   * 解析 `git worktree list --porcelain` 输出，只返回 `.easycode/worktrees/` 下的。
   */
  async list(): Promise<WorktreeInfo[]> {
    const gitRoot = this.getGitRoot();
    if (!gitRoot) return [];

    const result = await execGit(['worktree', 'list', '--porcelain'], gitRoot);
    if (!result.ok) return [];

    const worktreesRoot = canonical(this.getWorktreesRoot());
    const list: WorktreeInfo[] = [];

    let currentDir = '';
    let currentBranch = '';
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        // 先把上一条 push
        if (currentDir && canonical(currentDir).startsWith(worktreesRoot)) {
          list.push({
            name: path.basename(currentDir),
            branch: currentBranch,
            directory: currentDir,
          });
        }
        currentDir = line.slice('worktree '.length).trim();
        currentBranch = '';
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice('branch '.length).trim();
      } else if (line === '' && currentDir) {
        // 条目结束（空行分隔）
        if (canonical(currentDir).startsWith(worktreesRoot)) {
          list.push({
            name: path.basename(currentDir),
            branch: currentBranch,
            directory: currentDir,
          });
        }
        currentDir = '';
        currentBranch = '';
      }
    }
    // 尾部处理
    if (currentDir && canonical(currentDir).startsWith(worktreesRoot)) {
      list.push({
        name: path.basename(currentDir),
        branch: currentBranch,
        directory: currentDir,
      });
    }

    return list;
  }

  /**
   * 检查 worktree 目录是否有改动。
   * `git status --porcelain` 输出为空即 pristine。
   */
  async isPristine(directory: string): Promise<boolean> {
    const result = await execGit(['status', '--porcelain'], directory);
    if (!result.ok) return true; // 无法判断时视为干净，避免误 commit
    return result.stdout.trim() === '';
  }

  /**
   * 重置 worktree 到指定引用（含 submodule 处理）。
   * 拒绝重置主 workspace。
   *
   * 流程：
   * 1. 拒绝 directory === primary worktree
   * 2. git reset --hard <ref>
   * 3. git clean -ffdx
   * 4. submodule 三重处理
   * 5. status 校验
   */
  async reset(info: WorktreeInfo, targetRef?: string): Promise<void> {
    const dir = canonical(info.directory);
    const primary = canonical(this.projectRoot);
    if (dir === primary) {
      throw new WorktreeError(
        'RESET_PRIMARY',
        'Refusing to reset the primary workspace. Use a worktree directory.',
      );
    }

    const ref = targetRef ?? 'HEAD';

    // 1. reset
    const resetRes = await execGit(['reset', '--hard', ref], info.directory);
    if (!resetRes.ok) {
      throw new WorktreeError('RESET_FAILED', `git reset --hard failed: ${resetRes.stderr}`);
    }

    // 2. clean untracked
    await this.gitCleanForce(info.directory);

    // 3. submodule 三重处理（忽略错误——不是所有项目都有 submodule）
    await execGit(['submodule', 'update', '--init', '--recursive', '--force'], info.directory);
    await execGit(['submodule', 'foreach', '--recursive', 'git', 'reset', '--hard'], info.directory);
    await execGit(['submodule', 'foreach', '--recursive', 'git', 'clean', '-fdx'], info.directory);

    // 4. 校验
    const status = await execGit(['status', '--porcelain'], info.directory);
    if (status.ok && status.stdout.trim()) {
      throw new WorktreeError(
        'RESET_DIRTY',
        `Worktree still has changes after reset:\n${status.stdout}`,
      );
    }
  }

  // ── 私有辅助 ──

  /**
   * 确保 `.easycode/worktrees/` 被 .gitignore 忽略。
   * 若未被忽略，自动追加到 .gitignore 并提示。
   */
  private async ensureGitignored(gitRoot: string): Promise<void> {
    const ignorePath = path.join(gitRoot, '.gitignore');
    const pattern = `${EASYCODE_DIR}/${WORKTREES_DIR_NAME}/`;

    let content = '';
    try {
      content = await fsp.readFile(ignorePath, 'utf-8');
    } catch {
      // 不存在
    }

    if (content.split('\n').some((l) => l.trim() === pattern || l.trim() === `${EASYCODE_DIR}/`)) {
      return; // 已忽略
    }

    try {
      const addition = (content && !content.endsWith('\n') ? '\n' : '') + `\n# Easy Code worktree isolation\n${pattern}\n`;
      await fsp.appendFile(ignorePath, addition, 'utf-8');
    } catch {
      // 追加失败不致命
    }
  }

  /**
   * 底层清理：fsmonitor stop → worktree remove → branch -D → fs.rm。
   * @param deleteBranch 是否删除分支
   */
  private async cleanupByDir(
    directory: string,
    branch: string,
    deleteBranch: boolean = true,
  ): Promise<void> {
    const gitRoot = this.getGitRoot();
    if (!gitRoot) return;

    const release = await acquireLock(gitRoot);
    try {
      // 1. 停止 fsmonitor daemon（Windows 上可能锁定目录），忽略错误
      await execGit(['fsmonitor--daemon', 'stop'], directory).catch(() => {});

      // 2. worktree remove --force
      const removeRes = await execGit(['worktree', 'remove', '--force', directory], gitRoot);
      if (!removeRes.ok) {
        // 3. remove 失败则直接 fs.rm（带重试）
        await this.fsRemoveWithRetry(directory);
      }

      // 4. prune（清理元数据残留）
      await execGit(['worktree', 'prune'], gitRoot).catch(() => {});

      // 5. 删除分支
      if (deleteBranch && branch) {
        await execGit(['branch', '-D', branch], gitRoot).catch(() => {});
      }
    } finally {
      release();
    }

    // 兜底：确保目录确实消失
    if (fs.existsSync(directory)) {
      await this.fsRemoveWithRetry(directory);
    }
  }

  /** git clean -ffdx，失败时解析 stderr 提取失败文件重试一次。 */
  private async gitCleanForce(directory: string): Promise<void> {
    const res = await execGit(['clean', '-ffdx'], directory);
    if (res.ok) return;

    // 尝试 prune 后重试
    const gitRoot = this.getGitRoot();
    if (gitRoot) {
      await execGit(['worktree', 'prune'], gitRoot).catch(() => {});
    }
    await execGit(['clean', '-ffdx'], directory).catch(() => {});
  }

  /** fs.rm 带重试（应对 Windows 文件锁）。 */
  private async fsRemoveWithRetry(directory: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
      try {
        await fsp.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        if (!fs.existsSync(directory)) return;
      } catch {
        // 等待后重试
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
  }

  /** 同步等待 startCommand 完成。 */
  private async runStartCommand(command: string, cwd: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: 'ignore',
        windowsHide: true,
        detached: false,
      });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
  }

  /** fork startCommand 到后台（detached），立即返回。 */
  private forkStartCommand(command: string, cwd: string): void {
    try {
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      child.unref();
    } catch {
      // fork 失败不致命
    }
  }
}

// ─── 错误类型 ─────────────────────────────────────────────────────────────────

/** Worktree 相关错误。 */
export class WorktreeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}
