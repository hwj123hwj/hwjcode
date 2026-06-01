/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from '../config/config.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { GeminiClient } from './client.js';
import { SubAgent } from './subAgent.js';
import { getBuiltInAgentDefinition, resolveAgentTools } from '../agents/agentDefinition.js';

/**
 * Options passed to agent.run() inside a workflow script.
 * Designed for AI readability: every field has a clear machine-interpretable purpose.
 */
export interface WorkflowAgentRunOptions {
  /** Full task description for the sub-agent. Include all needed instructions inline. */
  prompt: string;
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
   * Use any model identifier supported by the current provider.
   * Examples: 'gemini-2.0-flash', 'claude-opus-4-5', 'gpt-4o'
   * Defaults to the global model configured in settings.
   */
  model?: string;
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
}

const DEFAULT_MAX_TURNS = 15;
const DEFAULT_MAX_CONCURRENCY = 6;

/**
 * Implements WorkflowAgentAPI. Each call to run() spins up a fresh SubAgent instance.
 * Context is serialized and appended to the prompt so the sub-agent can consume it
 * without needing a separate context-passing mechanism.
 */
export class WorkflowAgentBridge implements WorkflowAgentAPI {
  private readonly maxConcurrency: number;

  constructor(
    private readonly config: Config,
    private readonly toolRegistry: ToolRegistry,
    private readonly geminiClient: GeminiClient,
    private readonly abortSignal: AbortSignal,
    /** Optional callback for forwarding sub-agent output events upstream. */
    private readonly onUpdate?: (agentId: string, output: string) => void,
    maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
  ) {
    this.maxConcurrency = maxConcurrency;
  }

  async run(options: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult> {
    const prompt = this.buildPrompt(options);
    const agentType = options.agent_type ?? 'code-analysis';
    const maxTurns = options.max_turns ?? DEFAULT_MAX_TURNS;

    const agentDefinition = this.resolveAgentDefinition(agentType, maxTurns);
    const filteredRegistry = this.buildFilteredRegistry(agentDefinition);

    const agentId = `wf-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const subAgent = new SubAgent(
      this.config,
      filteredRegistry,
      this.geminiClient,
      (output: string) => this.onUpdate?.(agentId, output),
      this.abortSignal,
      undefined, // no pre-tool execution handler needed here
      agentDefinition,
      options.model, // per-agent model override
    );

    const result = await subAgent.executeTask(prompt, maxTurns);

    // Attempt to parse JSON from the summary for structured data passing.
    // The AI is encouraged to return JSON in its final response for downstream steps.
    let data: unknown = undefined;
    const jsonMatch = result.summary.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      result.summary.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      try {
        data = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
      } catch {
        // Not JSON — leave data undefined
      }
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

    // Semaphore-based concurrency control
    const results: WorkflowAgentRunResult[] = new Array(tasks.length);
    const queue = tasks.map((task, index) => ({ task, index }));
    let active = 0;
    let queueIndex = 0;

    await new Promise<void>((resolve, reject) => {
      const tryNext = () => {
        while (active < this.maxConcurrency && queueIndex < queue.length) {
          const { task, index } = queue[queueIndex++]!;
          active++;

          this.run(task)
            .then(result => {
              results[index] = result;
            })
            .catch(err => {
              reject(err);
            })
            .finally(() => {
              active--;
              if (queueIndex >= queue.length && active === 0) {
                resolve();
              } else {
                tryNext();
              }
            });
        }
      };

      tryNext();

      // Handle the case where tasks is empty (already handled above, but be safe)
      if (queue.length === 0) resolve();
    });

    return results;
  }

  /**
   * Build the final prompt for a sub-agent, appending structured context if provided.
   * The context section uses a machine-readable format: no markdown, raw JSON.
   * The sub-agent is expected to parse and use it directly.
   */
  private buildPrompt(options: WorkflowAgentRunOptions): string {
    if (options.context === undefined || options.context === null) {
      return options.prompt;
    }

    const contextJson = JSON.stringify(options.context, null, 2);
    return `${options.prompt}\n\n<workflow_context>\n${contextJson}\n</workflow_context>`;
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
