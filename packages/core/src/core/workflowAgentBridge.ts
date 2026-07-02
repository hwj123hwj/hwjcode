/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from '../config/config.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { GeminiClient } from './client.js';
import { SubAgent } from './subAgent.js';
import { getBuiltInAgentDefinition, resolveAgentTools } from '../agents/agentDefinition.js';
import { WorkflowRegistry } from './workflowRegistry.js';
import { WorktreeManager, WorktreeInfo } from '../utils/worktreeManager.js';

/**
 * Options passed to agent.run() inside a workflow script.
 * Designed for AI readability: every field has a clear machine-interpretable purpose.
 */
export interface WorkflowAgentRunOptions {
  /** Full task description for the sub-agent. Include all needed instructions inline. */
  prompt: string;
  /** Short label shown in the /workflow panel (e.g. "运行测试套件"). */
  label?: string;
  /**
   * Structured context from previous steps. Will be serialized and appended to the
   * sub-agent prompt so the sub-agent can consume prior results without extra turns.
   */
  context?: unknown;
  /** Agent specialization. Defaults to 'code-analysis'. */
  agent_type?: string;
  /** Max conversation turns. Defaults to 15. */
  max_turns?: number;
  /**
   * Optional model override for this specific sub-agent.
   * Examples: 'gemini-2.0-flash', 'claude-opus-4-5'
   */
  model?: string;
  /**
   * JSON Schema for structured output. When provided, the sub-agent is instructed
   * to return ONLY a JSON object matching this schema. The result is automatically
   * parsed and available as `result.data`.
   *
   * Example:
   *   schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }
   */
  schema?: Record<string, unknown>;

  /**
   * Whether to create an isolated git worktree for this sub-agent.
   * When true, the sub-agent runs in an independent physical directory with its
   * own branch, so file changes don't interfere with other parallel sub-agents.
   *
   * After the sub-agent finishes, changes are auto-committed to the worktree branch
   * and the worktree is cleaned up. If nothing changed, cleanup happens without commit.
   *
   * Only takes effect inside a git repository. Silently ignored otherwise.
   */
  worktree?: boolean;

  /**
   * Optional readable name for the worktree (generates branch `easycode/<name>`
   * and directory `.easycode/worktrees/<name>`). Falls back to a random slug if
   * omitted or empty.
   */
  worktreeName?: string;

  /**
   * Optional initialization command run inside the new worktree before the
   * sub-agent starts (e.g. `npm install`). Runs asynchronously in the background
   * so it doesn't block agent startup.
   */
  worktreeStartCommand?: string;
}

export interface WorkflowAgentRunResult {
  success: boolean;
  /** Text summary produced by the sub-agent. */
  result: string;
  /** Structured data if the sub-agent returned parseable JSON in its final response. */
  data?: unknown;
  /** Token usage for this sub-agent run. */
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * The `agent` object injected into the workflow sandbox.
 * This is the only API available to the orchestration script.
 */
export interface WorkflowAgentAPI {
  /**
   * Run a single sub-agent and await its result.
   * Blocks until the sub-agent finishes or the abort signal fires.
   */
  run(options: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult>;

  /**
   * Run multiple sub-agents in parallel.
   * Respects maxConcurrency. Results are returned in the same order as input tasks.
   * If any sub-agent throws, the error propagates and remaining tasks are cancelled.
   */
  runParallel(tasks: WorkflowAgentRunOptions[]): Promise<WorkflowAgentRunResult[]>;

  /**
   * Update the current phase index. Called by the workflow script's `phase()` function
   * to track which phase is currently executing.
   */
  setCurrentPhaseIndex(index: number): void;
}

const DEFAULT_MAX_TURNS = 15;
const DEFAULT_MAX_CONCURRENCY = 6;
const DEFAULT_MAX_AGENTS = 1000;
/** Per-agent hard deadline: 30 minutes. Prevents a single hung agent from blocking the workflow forever. */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Implements WorkflowAgentAPI. Each call to run() spins up a fresh SubAgent instance.
 * Context is serialized and appended to the prompt so the sub-agent can consume it
 * without needing a separate context-passing mechanism.
 */
export class WorkflowAgentBridge implements WorkflowAgentAPI {
  private readonly maxConcurrency: number;
  private readonly maxAgents: number;
  /** Cumulative total of agents spawned in this workflow (lifetime limit). */
  private totalAgentCount: number = 0;
  /** Current phase index. The workflow script should update this before each phase. */
  public currentPhaseIndex: number = 0;
  /**
   * When true, every sub-agent launched by run() gets its own isolated git worktree
   * unless the individual task opts out with `{ worktree: false }`.
   * Set by WorkflowTool when `worktree_mode: true` is passed.
   */
  private defaultWorktreeMode: boolean = false;

  setCurrentPhaseIndex(index: number): void {
    this.currentPhaseIndex = index;
  }

  constructor(
    private readonly config: Config,
    private readonly toolRegistry: ToolRegistry,
    private readonly geminiClient: GeminiClient,
    private readonly abortSignal: AbortSignal,
    /** Optional callback for forwarding sub-agent output events upstream. */
    private readonly onUpdate?: (agentId: string, output: string) => void,
    maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
    /** Workflow ID for registry tracking. */
    private readonly workflowId?: string,
    maxAgents: number = DEFAULT_MAX_AGENTS,
  ) {
    this.maxConcurrency = maxConcurrency;
    this.maxAgents = maxAgents;
  }

  /** Enable worktree mode for all subsequent sub-agents (unless overridden per-task). */
  setWorktreeMode(enabled: boolean): void {
    this.defaultWorktreeMode = enabled;
  }

  async run(options: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult> {
    // Hard limit: prevent runaway workflows from spinning up unlimited agents
    // This is a cumulative lifetime limit — once exceeded, no more agents can spawn
    // in this workflow, even if earlier agents have finished.
    this.totalAgentCount++;
    if (this.totalAgentCount > this.maxAgents) {
      throw new Error(
        `Workflow agent limit reached (max ${this.maxAgents}, used ${this.totalAgentCount}). ` +
        `Reduce the number of agent() calls or increase max_agents.`,
      );
    }

    const prompt = this.buildPrompt(options);
    const agentType = options.agent_type ?? 'code-analysis';
    const maxTurns = options.max_turns ?? DEFAULT_MAX_TURNS;

    const agentDefinition = this.resolveAgentDefinition(agentType, maxTurns);
    const filteredRegistry = this.buildFilteredRegistry(agentDefinition);

    const agentId = `wf-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const label = options.prompt.slice(0, 60) + (options.prompt.length > 60 ? '…' : '');

    // Register agent start
    if (this.workflowId) {
      WorkflowRegistry.startAgent(this.workflowId, agentId, label, options.prompt, options.model, this.currentPhaseIndex);
    }

    // ─── Worktree isolation ────────────────────────────────────────────────
    // Effective worktree flag: per-task override wins, else the bridge default.
    const useWorktree = options.worktree ?? this.defaultWorktreeMode;
    let worktreeInfo: WorktreeInfo | undefined;
    let wm: WorktreeManager | undefined;
    let effectiveConfig = this.config;

    if (useWorktree) {
      try {
        wm = new WorktreeManager(this.config.getProjectRoot());
        if (wm.isGitRepo()) {
          worktreeInfo = await wm.create({
            name: options.worktreeName,
            startCommand: options.worktreeStartCommand,
            asyncBoot: true,
          });
          // Clone Config so the sub-agent's file tools point at the worktree dir.
          effectiveConfig = await this.config.cloneForWorktree(worktreeInfo.directory);
        }
      } catch (err) {
        // Worktree creation failed — fall back to the shared workspace rather than
        // aborting the entire workflow. Log and continue.
        console.warn(
          `[WorkflowAgentBridge] worktree creation failed, falling back to shared workspace: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        worktreeInfo = undefined;
        wm = undefined;
      }
    }

    const subAgent = new SubAgent(
      effectiveConfig,
      filteredRegistry,
      this.geminiClient,
      (output: string) => this.onUpdate?.(agentId, output),
      this.abortSignal,
      // Track tool calls in real-time for the /workflow panel
      this.workflowId
        ? ({ tool, args }) => {
            const summary = `${tool.name}(${JSON.stringify(args).slice(0, 60)})`;
            WorkflowRegistry.updateAgentToolCall(this.workflowId!, agentId, summary);
          }
        : undefined,
      agentDefinition,
      options.model,
      // Real-time token update for the /workflow panel
      this.workflowId
        ? (tok) => {
            WorkflowRegistry.updateAgentTokens(this.workflowId!, agentId, tok);
            // Token update means AI just finished a turn → now thinking/deciding next step
            WorkflowRegistry.updateAgentPhase(this.workflowId!, agentId, 'thinking');
          }
        : undefined,
    );

    // Soft deadline: log a warning after 30min but do NOT abort the agent.
    // Complex tasks (large codebase analysis, long migrations) legitimately take longer.
    // Hard abort is left to the user via the global AbortSignal.
    const warningTimer = setTimeout(() => {
      console.warn(
        `[WorkflowAgentBridge] Agent "${label}" has been running for ${DEFAULT_AGENT_TIMEOUT_MS / 60000}min. ` +
        `It is still alive — this is a warning only. Use Ctrl+C to abort if needed.`
      );
    }, DEFAULT_AGENT_TIMEOUT_MS);

    let result: Awaited<ReturnType<typeof subAgent.executeTask>>;
    try {
      result = await subAgent.executeTask(prompt, maxTurns);
    } catch (err) {
      // On error: clean up the worktree (discard changes) before re-throwing.
      if (worktreeInfo && wm) {
        await wm.cleanup(worktreeInfo).catch(() => {});
      }
      clearTimeout(warningTimer);
      throw err;
    } finally {
      clearTimeout(warningTimer);
    }

    // ─── Worktree commit + cleanup (success path) ─────────────────────────
    if (worktreeInfo && wm) {
      try {
        const cleanupResult = await wm.commitAndCleanup(
          worktreeInfo,
          `easycode: ${options.label ?? options.prompt.slice(0, 80)}`,
        );
        if (cleanupResult.committed) {
          result.summary +=
            `\n\n[Worktree] Changes committed to branch \`${cleanupResult.branchName}\`` +
            ` (${cleanupResult.commitSha ?? 'unknown'}). Review and merge manually.`;
        } else if (!cleanupResult.success && cleanupResult.error) {
          // commit 失败 → 保留 worktree + 分支。告知用户有残留需手动处理。
          result.summary +=
            `\n\n[Worktree] ⚠️ Commit failed: ${cleanupResult.error}` +
            `\nWorktree \`${worktreeInfo.directory}\` and branch \`${worktreeInfo.branch}\` preserved for manual recovery.`;
        }
      } catch (err) {
        console.warn(
          `[WorkflowAgentBridge] worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Parse structured data from the summary.
    // When schema was provided, attempt strict JSON parse of the entire summary first;
    // otherwise fall back to extracting a JSON block from prose output.
    // If all parsing fails, wrap the raw text so callers never get data === undefined.
    let data: unknown = undefined;
    if (options.schema) {
      // Schema mode: the sub-agent should have returned raw JSON
      const cleaned = result.summary.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try { data = JSON.parse(cleaned); } catch { /* will try prose extraction below */ }
    }
    if (data === undefined) {
      const jsonMatch =
        result.summary.match(/```(?:json)?\s*([\s\S]*?)```/) ||
        result.summary.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        try { data = JSON.parse(jsonMatch[1] ?? jsonMatch[0]); } catch { /* not JSON */ }
      }
    }
    // Final fallback: ensure data is never undefined so scripts using result.data.xxx
    // get a meaningful error rather than a silent "Cannot read property of undefined".
    if (data === undefined) {
      data = { text: result.summary, _parse_failed: true };
    }

    const agentStatus = result.success ? 'completed' : 'failed';
    const outcome = result.success ? result.summary : (result.error ?? 'failed');

    // Register agent end
    if (this.workflowId) {
      WorkflowRegistry.endAgent(this.workflowId, agentId, agentStatus, outcome, result.tokenUsage);
    }

    return {
      success: result.success,
      result: result.summary,
      data,
      tokenUsage: result.tokenUsage,
    };
  }

  async runParallel(tasks: WorkflowAgentRunOptions[]): Promise<WorkflowAgentRunResult[]> {
    if (tasks.length === 0) return [];

    const results: WorkflowAgentRunResult[] = new Array(tasks.length);
    const queue = tasks.map((task, index) => ({ task, index }));
    let active = 0;
    let queueIndex = 0;

    // ── No fail-fast: each task is independent (especially in worktree mode).
    // A failure in one task does NOT cancel sibling tasks. All results are
    // collected and returned. This ensures worktree cleanup always runs for
    // every task, and sibling tasks that could succeed are not wasted.
    //
    // Parent abort is still respected: when the parent AbortController fires,
    // in-flight sub-agents stop naturally (they're bound to abortSignal), and
    // we skip scheduling remaining tasks.
    await new Promise<void>((resolve) => {
      const tryNext = () => {
        while (!this.abortSignal.aborted && active < this.maxConcurrency && queueIndex < queue.length) {
          const { task, index } = queue[queueIndex++]!;
          active++;

          this.run(task)
            .then(result => {
              results[index] = result;
            })
            .catch(err => {
              // Record the error as a failed result — don't abort sibling tasks.
              results[index] = {
                success: false,
                result: `Task failed: ${err instanceof Error ? err.message : String(err)}`,
                tokenUsage: undefined,
              };
            })
            .finally(() => {
              active--;
              // Resolve when all tasks dispatched AND all active finished,
              // OR when parent aborted (remaining queue tasks will never start).
              // Without the abort check, Promise would deadlock on Ctrl+C
              // (queueIndex < queue.length but tryNext is never called again).
              if (active === 0 && (queueIndex >= queue.length || this.abortSignal.aborted)) {
                resolve();
              } else if (!this.abortSignal.aborted) {
                tryNext();
              }
            });
        }
        // Resolve immediately if no tasks or parent already aborted
        if (queue.length === 0 || (active === 0 && this.abortSignal.aborted)) {
          resolve();
        }
      };
      tryNext();
    });

    // Fill any never-started slots with error placeholders so callers don't hit undefined
    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) {
        results[i] = { success: false, result: 'Cancelled: workflow abort', tokenUsage: undefined };
      }
    }

    return results;
  }

  /**
   * Build the final prompt for a sub-agent, appending structured context and schema
   * requirements if provided. When `schema` is set, the sub-agent is instructed to
   * respond ONLY with a JSON object matching the schema — no prose, no markdown fences.
   *
   * Context size is capped at MAX_CONTEXT_CHARS to prevent prompt explosion when
   * upstream agents return raw file contents instead of distilled summaries.
   * Claude Code's own guidance: sub-agents should return 1k-2k token summaries, not raw data.
   */
  private buildPrompt(options: WorkflowAgentRunOptions): string {
    // ~20k chars ≈ 5k tokens — enough for rich structured summaries, hard cap against raw-content blowup
    const MAX_CONTEXT_CHARS = 20000;

    let prompt = options.prompt;

    // Append structured context from previous steps
    if (options.context !== undefined && options.context !== null) {
      let contextJson = JSON.stringify(options.context, null, 2);
      if (contextJson.length > MAX_CONTEXT_CHARS) {
        const originalLen = contextJson.length;
        contextJson = contextJson.slice(0, MAX_CONTEXT_CHARS);
        // Trim to last complete line to avoid broken JSON mid-string
        const lastNewline = contextJson.lastIndexOf('\n');
        if (lastNewline > MAX_CONTEXT_CHARS * 0.8) {
          contextJson = contextJson.slice(0, lastNewline);
        }
        contextJson += `\n... [context truncated: ${originalLen} chars → ${MAX_CONTEXT_CHARS} chars max. Sub-agents should return distilled JSON summaries, not raw file contents.]`;
        console.warn(`[WorkflowAgentBridge] context truncated from ${originalLen} to ${MAX_CONTEXT_CHARS} chars for agent: "${options.label ?? options.prompt.slice(0, 60)}"`);
      }
      prompt += `\n\n<workflow_context>\n${contextJson}\n</workflow_context>`;
    }

    // Append schema constraint — force structured JSON output
    if (options.schema) {
      const schemaJson = JSON.stringify(options.schema, null, 2);
      prompt += `\n\n<output_schema>\nYou MUST respond with ONLY a valid JSON object matching this schema. No prose, no markdown fences, no explanation — raw JSON only:\n${schemaJson}\n</output_schema>`;
    }

    return prompt;
  }

  private resolveAgentDefinition(agentType: string, maxTurns: number) {
    const allTools = this.toolRegistry.getAllTools();
    const def = getBuiltInAgentDefinition(agentType, [], maxTurns);
    if (!def) {
      throw new Error(`Unknown agent_type: "${agentType}"`);
    }
    const availableToolNames = resolveAgentTools(def, allTools).resolvedTools.map(t => t.name);
    return getBuiltInAgentDefinition(agentType, availableToolNames, maxTurns)!;
  }

  private buildFilteredRegistry(agentDefinition: ReturnType<typeof getBuiltInAgentDefinition>) {
    const filteredRegistry = new ToolRegistry(this.config);
    const allTools = this.toolRegistry.getAllTools();
    const resolved = resolveAgentTools(agentDefinition!, allTools);
    resolved.resolvedTools.forEach(tool => filteredRegistry.registerTool(tool));
    return filteredRegistry;
  }
}
