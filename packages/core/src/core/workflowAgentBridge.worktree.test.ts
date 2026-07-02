/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Integration tests for WorkflowAgentBridge worktree isolation.
 *
 * Verifies that when `worktree_mode: true`, each sub-agent runs in an isolated
 * git worktree, and changes are auto-committed to a dedicated branch after the
 * agent finishes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { WorkflowAgentBridge } from './workflowAgentBridge.js';
import { Config } from '../config/config.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { GeminiClient } from './client.js';
import { SubAgent } from './subAgent.js';
import { WorktreeManager } from '../utils/worktreeManager.js';

// ─── Mocks (same pattern as workflowAgentBridge.test.ts) ─────────────────────

vi.mock('./subAgent.js', () => ({
  SubAgent: vi.fn(),
}));

vi.mock('../agents/agentDefinition.js', () => ({
  getBuiltInAgentDefinition: vi.fn().mockReturnValue({
    systemPrompt: 'You are a helpful agent.',
    allowedTools: [],
    name: 'code-analysis',
  }),
  resolveAgentTools: vi.fn().mockReturnValue({ resolvedTools: [] }),
}));

vi.mock('./workflowRegistry.js', () => ({
  WorkflowRegistry: {
    startAgent: vi.fn(),
    endAgent: vi.fn(),
    updateAgentTokens: vi.fn(),
    updateAgentToolCall: vi.fn(),
    updateAgentPhase: vi.fn(),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-int-'));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# init\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * A SubAgent mock that simulates the sub-agent writing a file into its workspace,
 * so we can verify worktree isolation. The file is written to the Config's
 * targetDir (which is the worktree dir when worktree is enabled).
 */
function makeSubAgentWriteFileMock(filename: string, content: string) {
  return (SubAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (config: Config) => ({
      executeTask: vi.fn().mockImplementation(async () => {
        // Simulate the sub-agent creating a file in its workspace
        const dir = config.getProjectRoot();
        fs.writeFileSync(path.join(dir, filename), content);
        return {
          success: true,
          summary: `Created ${filename}`,
          executionLog: [],
          tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      }),
    }),
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const GIT_TEST_TIMEOUT = 30000;

describe('WorkflowAgentBridge — worktree integration', () => {
  let repoDir: string;
  let mockConfig: Config;
  let mockRegistry: ToolRegistry;

  beforeEach(() => {
    repoDir = createTempGitRepo();
    // Real Config so cloneForWorktree actually runs
    mockConfig = {
      getProjectRoot: () => repoDir,
      getSessionId: () => 'test-session',
      getModel: () => 'auto',
      getEmbeddingModel: () => 'text-embedding-004',
      getCustomModels: () => [],
      getCloudModels: () => [],
      getModelOverrides: () => ({}),
      getMcpServers: () => undefined,
      getCoreTools: () => undefined,
      getExcludeTools: () => undefined,
      getProxy: () => undefined,
      getCustomProxyServerUrl: () => undefined,
      getSandbox: () => undefined,
      getDebugMode: () => false,
      getApprovalMode: () => 'auto',
      getHookSystem: () => ({ getEventHandler: () => undefined }),
      // cloneForWorktree returns a minimal mock that tracks the worktree dir
      cloneForWorktree: vi.fn().mockImplementation(async (targetDir: string) => ({
        getProjectRoot: () => targetDir,
        getSessionId: () => 'test-session',
        getApprovalMode: () => 'auto',
        getHookSystem: () => ({ getEventHandler: () => undefined }),
      })),
    } as unknown as Config;

    mockRegistry = {
      getAllTools: () => [],
      registerTool: vi.fn(),
    } as unknown as ToolRegistry;
  });

  afterEach(() => {
    rmrf(repoDir);
  });

  it('runs a sub-agent in an isolated worktree when worktree:true', async () => {
    makeSubAgentWriteFileMock('agent-A.txt', 'from-agent-A');

    const bridge = new WorkflowAgentBridge(
      mockConfig,
      mockRegistry,
      {} as GeminiClient,
      new AbortController().signal,
      undefined,
      6,
      undefined,
      1000,
    );

    const result = await bridge.run({
      prompt: 'create file A',
      worktree: true,
      worktreeName: 'feat-a',
    });

    expect(result.success).toBe(true);
    // The file must NOT exist in the main workspace (isolation!)
    expect(fs.existsSync(path.join(repoDir, 'agent-A.txt'))).toBe(false);
    // The worktree should be cleaned up (directory gone)
    const wtRoot = path.join(repoDir, '.easycode', 'worktrees');
    expect(fs.existsSync(path.join(wtRoot, 'feat-a'))).toBe(false);
    // But the change should be committed to the branch
    const branchCheck = execSync('git show-ref --verify --quiet refs/heads/easycode/feat-a && echo yes || echo no', {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();
    expect(branchCheck).toBe('yes');
  }, GIT_TEST_TIMEOUT);

  it('falls back to shared workspace when worktree creation fails (non-git)', async () => {
    // Use a non-git directory
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-nogit-'));
    const nonGitConfig = {
      ...mockConfig,
      getProjectRoot: () => plainDir,
      cloneForWorktree: mockConfig.cloneForWorktree,
    } as unknown as Config;

    const writeMock = makeSubAgentWriteFileMock('plain.txt', 'shared');
    try {
      const bridge = new WorkflowAgentBridge(
        nonGitConfig,
        mockRegistry,
        {} as GeminiClient,
        new AbortController().signal,
        undefined,
        6,
        undefined,
        1000,
      );

      // Should not throw — falls back to shared workspace
      const result = await bridge.run({
        prompt: 'task',
        worktree: true,
        worktreeName: 'will-fail',
      });

      expect(result.success).toBe(true);
      // File was written to the shared workspace
      expect(fs.existsSync(path.join(plainDir, 'plain.txt'))).toBe(true);
    } finally {
      rmrf(plainDir);
      void writeMock;
    }
  }, GIT_TEST_TIMEOUT);

  it('worktree_mode: true enables isolation for all sub-agents by default', async () => {
    makeSubAgentWriteFileMock('iso.txt', 'isolated');

    const bridge = new WorkflowAgentBridge(
      mockConfig,
      mockRegistry,
      {} as GeminiClient,
      new AbortController().signal,
      undefined,
      6,
      undefined,
      1000,
    );
    (bridge as WorkflowAgentBridge).setWorktreeMode(true);

    const result = await bridge.run({
      prompt: 'task in isolation',
      worktreeName: 'default-mode',
    });

    expect(result.success).toBe(true);
    // Main workspace untouched
    expect(fs.existsSync(path.join(repoDir, 'iso.txt'))).toBe(false);
    // Branch created
    const branchCheck = execSync('git show-ref --verify --quiet refs/heads/easycode/default-mode && echo yes || echo no', {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();
    expect(branchCheck).toBe('yes');
  }, GIT_TEST_TIMEOUT);

  it('per-task worktree:false overrides bridge worktree_mode', async () => {
    makeSubAgentWriteFileMock('shared.txt', 'in-main-workspace');

    const bridge = new WorkflowAgentBridge(
      mockConfig,
      mockRegistry,
      {} as GeminiClient,
      new AbortController().signal,
      undefined,
      6,
      undefined,
      1000,
    );
    (bridge as WorkflowAgentBridge).setWorktreeMode(true);

    // Explicitly disable worktree for this task
    const result = await bridge.run({
      prompt: 'task in shared',
      worktree: false,
    });

    expect(result.success).toBe(true);
    // File was written to the shared (main) workspace
    expect(fs.existsSync(path.join(repoDir, 'shared.txt'))).toBe(true);
  }, GIT_TEST_TIMEOUT);

  it('runParallel with worktree creates multiple isolated branches', async () => {
    // Mock that writes different files based on the prompt
    (SubAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (config: Config) => ({
        executeTask: vi.fn().mockImplementation(async (prompt: string) => {
          const dir = config.getProjectRoot();
          const name = prompt.includes('task-A') ? 'A' : 'B';
          fs.writeFileSync(path.join(dir, `parallel-${name}.txt`), `content-${name}`);
          return {
            success: true,
            summary: `done-${name}`,
            executionLog: [],
            tokenUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          };
        }),
      }),
    );

    const bridge = new WorkflowAgentBridge(
      mockConfig,
      mockRegistry,
      {} as GeminiClient,
      new AbortController().signal,
      undefined,
      2, // maxConcurrency
      undefined,
      1000,
    );
    (bridge as WorkflowAgentBridge).setWorktreeMode(true);

    const results = await bridge.runParallel([
      { prompt: 'do task-A', worktreeName: 'parallel-a' },
      { prompt: 'do task-B', worktreeName: 'parallel-b' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(true);

    // Main workspace must be clean of both files
    expect(fs.existsSync(path.join(repoDir, 'parallel-A.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'parallel-B.txt'))).toBe(false);

    // Both branches created
    for (const b of ['easycode/parallel-a', 'easycode/parallel-b']) {
      const check = execSync(`git show-ref --verify --quiet refs/heads/${b} && echo yes || echo no`, {
        cwd: repoDir,
        encoding: 'utf-8',
      }).trim();
      expect(check).toBe('yes');
    }
  }, GIT_TEST_TIMEOUT);

  it('pristine worktree (no changes) is cleaned up without commit', async () => {
    // Mock that does NOT write any file
    (SubAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      executeTask: vi.fn().mockResolvedValue({
        success: true,
        summary: 'nothing to do',
        executionLog: [],
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    }));

    const bridge = new WorkflowAgentBridge(
      mockConfig,
      mockRegistry,
      {} as GeminiClient,
      new AbortController().signal,
      undefined,
      6,
      undefined,
      1000,
    );

    const result = await bridge.run({
      prompt: 'no-op task',
      worktree: true,
      worktreeName: 'pristine-task',
    });

    expect(result.success).toBe(true);
    // Worktree directory gone
    expect(fs.existsSync(path.join(repoDir, '.easycode', 'worktrees', 'pristine-task'))).toBe(false);
    // Branch should NOT exist (cleaned up, no commit)
    const branchCheck = execSync('git show-ref --verify --quiet refs/heads/easycode/pristine-task && echo yes || echo no', {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();
    expect(branchCheck).toBe('no');
  }, GIT_TEST_TIMEOUT);
});
