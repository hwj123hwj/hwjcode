/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for WorktreeManager.
 *
 * Uses real git operations against temporary git repositories created in the
 * OS temp directory. This gives end-to-end coverage of the worktree lifecycle
 * (create → commit → cleanup → list → reset) without mocking git itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  WorktreeManager,
  WorktreeError,
  slugify,
  canonical,
  execGit,
} from './worktreeManager.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a temporary git repo and return its path. */
function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# init\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

/** Recursively remove a directory, ignoring errors. */
function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── Pure function tests ─────────────────────────────────────────────────────

describe('slugify', () => {
  it('converts spaces and mixed case to kebab-case', () => {
    expect(slugify('Fix Auth Bug')).toBe('fix-auth-bug');
  });

  it('collapses runs of non-alphanumeric into single dash', () => {
    expect(slugify('feat___123')).toBe('feat-123');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('returns empty string for pure non-ASCII (Chinese)', () => {
    expect(slugify('重构用户模块')).toBe('');
  });

  it('keeps the ASCII part of mixed strings', () => {
    expect(slugify('feat-123 支付')).toBe('feat-123');
  });
});

describe('canonical', () => {
  it('normalizes path separators', () => {
    const c = canonical(path.join('/tmp', 'a', '..', 'b'));
    expect(c).toBe(path.normalize('/tmp/b'));
  });

  it('returns a resolved path for non-existent paths (no throw)', () => {
    const c = canonical('/tmp/definitely-does-not-exist-xyz');
    expect(c).toBe(path.normalize(path.resolve('/tmp/definitely-does-not-exist-xyz')));
  });
});

// ─── execGit ─────────────────────────────────────────────────────────────────

describe('execGit', () => {
  it('returns ok=true for a valid command', async () => {
    const r = await execGit(['--version'], process.cwd());
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('git version');
  });

  it('returns ok=false for an invalid ref', async () => {
    const r = await execGit(['show-ref', '--verify', '--quiet', 'refs/heads/nope-xyz'], process.cwd());
    expect(r.ok).toBe(false);
  });
});

// ─── WorktreeManager against a real temp repo ────────────────────────────────
//
// Git operations (init/worktree add/commit) are I/O heavy — give generous timeouts.
const GIT_TEST_TIMEOUT = 30000;

describe('WorktreeManager', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(() => {
    // ensure no dangling locks for the next test
    rmrf(repoDir);
  });

  describe('static methods', () => {
    it('isGitRepo detects a git repo', () => {
      expect(WorktreeManager.isGitRepo(repoDir)).toBe(true);
    });

    it('isGitRepo returns false for a plain directory', () => {
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plain-'));
      expect(WorktreeManager.isGitRepo(plain)).toBe(false);
      rmrf(plain);
    });

    it('getWorktreesRoot returns <projectRoot>/.easycode/worktrees', () => {
      const root = WorktreeManager.getWorktreesRoot(repoDir);
      expect(root).toBe(path.join(repoDir, '.easycode', 'worktrees'));
    });
  });

  describe('create', () => {
    it('creates a worktree with the given name', async () => {
      const wm = new WorktreeManager(repoDir);
      const info = await wm.create({ name: 'fix-bug', asyncBoot: false });

      expect(info.name).toBe('fix-bug');
      expect(info.branch).toBe('easycode/fix-bug');
      expect(fs.existsSync(info.directory)).toBe(true);
      // Files from HEAD are present
      expect(fs.existsSync(path.join(info.directory, 'README.md'))).toBe(true);
    }, GIT_TEST_TIMEOUT);

    it('appends random suffix on name conflict', async () => {
      const wm = new WorktreeManager(repoDir);
      const first = await wm.create({ name: 'conflict-name', asyncBoot: false });
      const second = await wm.create({ name: 'conflict-name', asyncBoot: false });

      expect(first.name).toBe('conflict-name');
      expect(second.name).not.toBe('conflict-name');
      expect(second.name).toContain('conflict-name');
      expect(fs.existsSync(second.directory)).toBe(true);
    }, GIT_TEST_TIMEOUT);

    it('falls back to random slug when name is pure non-ASCII', async () => {
      const wm = new WorktreeManager(repoDir);
      const info = await wm.create({ name: '重构模块', asyncBoot: false });

      expect(info.name).toBeTruthy();
      expect(info.branch).toBe(`easycode/${info.name}`);
      expect(fs.existsSync(info.directory)).toBe(true);
    }, GIT_TEST_TIMEOUT);

    it('throws WorktreeError when not in a git repo', async () => {
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-nogit-'));
      try {
        const wm = new WorktreeManager(plain);
        await expect(wm.create({ name: 'x' })).rejects.toThrow(WorktreeError);
      } finally {
        rmrf(plain);
      }
    }, GIT_TEST_TIMEOUT);

    it('adds .easycode/worktrees/ to .gitignore', async () => {
      const wm = new WorktreeManager(repoDir);
      await wm.create({ name: 'gitignore-check', asyncBoot: false });

      const gitignore = await fsp.readFile(path.join(repoDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.easycode/worktrees/');
    }, GIT_TEST_TIMEOUT);
  });

  describe('isPristine', () => {
    it('returns true for an untouched worktree', async () => {
      const wm = new WorktreeManager(repoDir);
      const info = await wm.create({ name: 'pristine', asyncBoot: false });
      expect(await wm.isPristine(info.directory)).toBe(true);
    }, GIT_TEST_TIMEOUT);

    it('returns false after modifying a file', async () => {
      const wm = new WorktreeManager(repoDir);
      const info = await wm.create({ name: 'dirty', asyncBoot: false });
      await fsp.writeFile(path.join(info.directory, 'README.md'), '# changed\n');
      expect(await wm.isPristine(info.directory)).toBe(false);
    }, GIT_TEST_TIMEOUT);
  });

  describe('commitAndCleanup', () => {
    it('detects pristine state and skips commit (committed: false)', async () => {
      const wm = new WorktreeManager(repoDir);
      const info = await wm.create({ name: 'clean-wt', asyncBoot: false });

      const result = await wm.commitAndCleanup(info, 'test: clean');

      expect(result.success).toBe(true);
      expect(result.committed).toBe(false);
      // directory is gone
      expect(fs.existsSync(info.directory)).toBe(false);
    }, GIT_TEST_TIMEOUT);

    it('commits changes when worktree is dirty (committed: true)', async () => {
      const wm = new WorktreeManager(repoDir);
      const info = await wm.create({ name: 'dirty-wt', asyncBoot: false });
      await fsp.writeFile(path.join(info.directory, 'new-file.txt'), 'content');
      // Configure git identity in the worktree (inherited but ensure)
      execSync('git config user.email "wt@test.com"', { cwd: info.directory, stdio: 'ignore' });
      execSync('git config user.name "WT"', { cwd: info.directory, stdio: 'ignore' });

      const result = await wm.commitAndCleanup(info, 'feat: add new file');

      expect(result.success).toBe(true);
      expect(result.committed).toBe(true);
      expect(result.branchName).toBe('easycode/dirty-wt');
      expect(result.commitSha).toBeTruthy();
      // directory is gone, but branch is preserved (because committed)
      expect(fs.existsSync(info.directory)).toBe(false);
      // branch still exists
      const refCheck = await execGit(
        ['show-ref', '--verify', '--quiet', `refs/heads/easycode/dirty-wt`],
        repoDir,
      );
      expect(refCheck.ok).toBe(true);
    }, GIT_TEST_TIMEOUT);
  });

  describe('cleanup', () => {
    it('removes worktree and branch even when dirty', async () => {
      const wm = new WorktreeManager(repoDir);
      const info = await wm.create({ name: 'cleanup-test', asyncBoot: false });
      await fsp.writeFile(path.join(info.directory, 'scratch.txt'), 'x');

      await wm.cleanup(info);

      expect(fs.existsSync(info.directory)).toBe(false);
      const refCheck = await execGit(
        ['show-ref', '--verify', '--quiet', `refs/heads/easycode/cleanup-test`],
        repoDir,
      );
      expect(refCheck.ok).toBe(false);
    }, GIT_TEST_TIMEOUT);

    it('is idempotent (calling twice does not throw)', async () => {
      const wm = new WorktreeManager(repoDir);
      const info = await wm.create({ name: 'idempotent', asyncBoot: false });
      await wm.cleanup(info);
      // second call should not throw
      await expect(wm.cleanup(info)).resolves.toBeUndefined();
    }, GIT_TEST_TIMEOUT);
  });

  describe('list', () => {
    it('returns all worktrees created under .easycode/worktrees/', async () => {
      const wm = new WorktreeManager(repoDir);
      await wm.create({ name: 'list-a', asyncBoot: false });
      await wm.create({ name: 'list-b', asyncBoot: false });

      const list = await wm.list();
      const names = list.map((w) => w.name);
      expect(names).toContain('list-a');
      expect(names).toContain('list-b');
    }, GIT_TEST_TIMEOUT);

    it('excludes the primary worktree', async () => {
      const wm = new WorktreeManager(repoDir);
      await wm.create({ name: 'list-c', asyncBoot: false });
      const list = await wm.list();
      // none of them should be the repoDir itself
      for (const w of list) {
        expect(canonical(w.directory)).not.toBe(canonical(repoDir));
      }
    }, GIT_TEST_TIMEOUT);
  });

  describe('reset', () => {
    it('resets a dirty worktree back to clean state', async () => {
      const wm = new WorktreeManager(repoDir);
      const info = await wm.create({ name: 'reset-test', asyncBoot: false });
      // dirty it
      await fsp.writeFile(path.join(info.directory, 'README.md'), '# changed\n');
      await fsp.writeFile(path.join(info.directory, 'junk.txt'), 'junk');
      expect(await wm.isPristine(info.directory)).toBe(false);

      await wm.reset(info, 'HEAD');

      expect(await wm.isPristine(info.directory)).toBe(true);
      // junk.txt should be cleaned away
      expect(fs.existsSync(path.join(info.directory, 'junk.txt'))).toBe(false);
    }, GIT_TEST_TIMEOUT);

    it('refuses to reset the primary workspace', async () => {
      const wm = new WorktreeManager(repoDir);
      await expect(
        wm.reset({ name: 'x', branch: 'x', directory: repoDir }),
      ).rejects.toThrow(WorktreeError);
    });
  });

  describe('concurrency lock', () => {
    it('serializes concurrent creates on the same repo', async () => {
      const wm = new WorktreeManager(repoDir);
      // Fire 5 concurrent creates; they must all succeed without git lock errors
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          wm.create({ name: `conc-${i}`, asyncBoot: false }),
        ),
      );
      expect(results).toHaveLength(5);
      for (const r of results) {
        expect(fs.existsSync(r.directory)).toBe(true);
      }
    }, GIT_TEST_TIMEOUT);
  });
});
