/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import {
  BaseTool,
  ToolResult,
  Icon,
  ToolCallConfirmationDetails,
  ToolWorkflowConfirmationDetails,
  WorkflowPhase,
  ToolConfirmationOutcome,
  ToolExecutionServices,
} from './tools.js';
import { ToolRegistry } from './tool-registry.js';
import { Config } from '../config/config.js';
import { WorkflowAgentBridge } from '../core/workflowAgentBridge.js';
import { runWorkflowScript, extractMeta } from '../core/workflowRunner.js';
import { resolveBuiltinWorkflow, isBuiltinWorkflow, listBuiltinWorkflows } from '../core/builtinWorkflows.js';
import { ToolExecutionContext } from '../core/toolSchedulerAdapter.js';
import { WorkflowRegistry } from '../core/workflowRegistry.js';

export interface WorkflowToolParams {
  /**
   * Name of a built-in workflow to run (e.g. "batch-parallel").
   *
   * When set, the tool resolves the named template and auto-generates the
   * orchestration script — the AI does NOT need to write `script` manually.
   * Pass `args` to provide the template's input data.
   *
   * Currently available built-ins:
   * - `"batch-parallel"`: Run N independent tasks in parallel, each in its own
   *   git worktree. Args: `{ tasks: [{ prompt, label?, name? }] }`.
   *   Auto-enables `worktree_mode`.
   */
  name?: string;

  /**
   * Arguments to pass to a built-in workflow (used only when `name` is set).
   * Must be JSON-serializable.
   */
  args?: unknown;

  /**
   * A JavaScript orchestration script that drives the workflow.
   *
   * EITHER `name` OR `script` must be provided (not both).
   *
   * Requirements:
   * - Must export a default async function that accepts a single `agent` argument.
   * - Use `await agent.run({...})` for serial sub-agent execution.
   * - Use `await agent.runParallel([...])` for parallel sub-agent execution.
   * - Pass results between steps via plain JavaScript variables.
   * - Return a string (or JSON-serializable value) as the final result.
   *
   * Example:
   * ```javascript
   * export default async function(agent) {
   *   const [auth, api] = await agent.runParallel([
   *     { prompt: 'Audit src/auth/ for SQL injection. Return JSON: [{file,line,issue}]', max_turns: 8 },
   *     { prompt: 'Audit src/api/ for missing input validation. Return JSON: [{file,line,issue}]', max_turns: 8 },
   *   ]);
   *   const findings = [...(auth.data ?? []), ...(api.data ?? [])];
   *   if (findings.length === 0) return 'No issues found.';
   *   const fix = await agent.run({
   *     prompt: 'Fix all reported issues.',
   *     context: findings,
   *     max_turns: 20,
   *   });
   *   return fix.result;
   * }
   * ```
   */
  script?: string;

  /** Short human-readable description for UI display (3-8 words). */
  description: string;

  /**
   * Maximum number of sub-agents that may run concurrently.
   * Defaults to 6. Set lower to reduce API quota pressure.
   */
  max_concurrency?: number;

  /**
   * Maximum total number of sub-agents this workflow may spawn.
   * Defaults to 1000 (matches Claude Code's limit). Hard ceiling — exceeding it
   * throws an error and aborts the workflow.
   */
  max_agents?: number;

  /**
   * When true, every sub-agent in this workflow runs inside its own isolated
   * git worktree (independent directory + branch), so parallel tasks don't
   * clobber each other's files. Only effective inside a git repository.
   *
   * Individual agents can still opt out with `{ worktree: false }` in the
   * workflow script.
   *
   * After each agent finishes, its changes are auto-committed to a dedicated
   * branch (e.g. `easycode/<name>`) for manual review/merge, then the worktree
   * is cleaned up.
   */
  worktree_mode?: boolean;
}

/**
 * WorkflowTool — executes an AI-generated JavaScript orchestration script
 * that coordinates multiple sub-agents to tackle large-scale engineering tasks.
 *
 * Trigger convention: include the word "workflow" in your prompt, or invoke
 * this tool directly when a task requires parallel sub-agent coordination.
 *
 * The script runs in a Node.js vm sandbox with no filesystem/network access.
 * It communicates exclusively through the `agent` API injected into the sandbox.
 */
export class WorkflowTool extends BaseTool<WorkflowToolParams, ToolResult> {
  static readonly Name = 'workflow';

  constructor(
    private readonly config: Config,
    private readonly toolRegistry: ToolRegistry,
  ) {
    super(
      WorkflowTool.Name,
      'Dynamic Workflow Orchestrator',
      `Execute a JavaScript orchestration script that coordinates multiple parallel sub-agents to solve large-scale or multi-step engineering tasks.

Use this tool ONLY when explicitly triggered by the magic word (see below). Do NOT self-invoke based on task complexity. Typical use cases (only when triggered):
- Requires parallel analysis or execution across many files/modules
- Has dependent steps where later agents need structured results from earlier ones
- Is too large or complex for a single sub-agent or linear tool calls
- Matches patterns like: codebase-wide audits, large migrations, cross-module refactors, deep research

ONLY invoke this tool when the user's message contains the exact word "workflow". Do NOT invoke for /goal, task planning, or any other purpose — even if the task seems large or complex.

**Script format** (follow exactly):

\`\`\`javascript
export const meta = {
  name: 'workflow-slug',          // kebab-case identifier
  description: '简短描述',
  phases: [
    { title: '阶段名', detail: '详细说明' },
  ],
};

phase('阶段名');  // REQUIRED before each phase — updates the UI tracker

const result = await agent('prompt text', {
  label: 'UI显示标签',            // short label for /workflow panel
  schema: { type: 'object', properties: { ... }, required: [...] },  // optional: force JSON output
  model: 'gemini-2.0-flash',     // optional: per-agent model override
  context: previousResult,       // optional: pass prior results
});

// Parallel execution:
const [r1, r2] = await Promise.all([
  agent('prompt1', { label: '任务1' }),
  agent('prompt2', { label: '任务2' }),
]);

export default async function(agent) {
  // orchestration logic
}
\`\`\`

**API reference**:
- \`phase(title)\` — advance the phase tracker; title must match one of \`meta.phases[].title\`
- \`await agent(prompt, opts)\` or \`await agent.run({ prompt, ...opts })\` — run one sub-agent
  - opts: \`{ label, schema, model, context, max_turns, agent_type }\`
  - returns: \`{ success, result, data }\` — \`data\` is auto-parsed JSON when \`schema\` is set
- \`await agent.runParallel([...tasks])\` — run multiple sub-agents concurrently (max ${6} by default)
- \`schema\`: JSON Schema object — forces the sub-agent to return structured JSON; result available as \`result.data\`
- \`model\`: per-step model override, e.g. \`'gemini-2.0-flash'\` for fast steps, \`'gemini-2.5-pro'\` for deep reasoning

**Context passing**: set \`context\` to any JSON-serializable value from a previous step. It will be injected into the sub-agent prompt automatically.

**CRITICAL — Keep sub-agent outputs lean (Claude Code's core principle):**
Each sub-agent must return a **distilled JSON summary** (target: under 2000 tokens), NOT raw file contents or tool outputs.
- ✅ Good: \`{ "files": ["a.ts","b.ts"], "issues": [{"file":"a.ts","line":12,"desc":"..."}] }\`
- ❌ Bad: returning full file contents, raw command output, or unstructured prose
- Always use \`schema\` to enforce structured output on data-collection agents
- The orchestrator context budget is finite — one agent returning raw code blows up all subsequent agents
- Sub-agents should explore extensively with tools but **summarize aggressively before returning**`,
      Icon.Tasks,
      {
        type: Type.OBJECT,
        properties: {
          name: {
            type: Type.STRING,
            description:
              '(Recommended) Name of a built-in workflow to run. Available: "batch-parallel" — run N independent tasks in parallel with git worktree isolation.\n' +
              'When set, you do NOT need to write `script`. Just provide `args`.\n\n' +
              '### When to use `name: "batch-parallel"`:\n' +
              'Use this when the user has a LIST of independent tasks — e.g.:\n' +
              '- A requirements/PRD document with multiple improvement items\n' +
              '- Multiple bug fixes or feature requests to process at once\n' +
              '- A checklist of changes to apply to different parts of the codebase\n\n' +
              '### How to use:\n' +
              '1. Extract each task into a clear prompt string.\n' +
              '2. Call workflow with name="batch-parallel" and args={tasks:[...]}.\n' +
              '3. Each task runs in its own git worktree (isolated directory + branch).',
          },
          args: {
            type: Type.OBJECT,
            description:
              'Arguments for a built-in workflow (used with `name`). For "batch-parallel": { tasks: [{ prompt: string, label?: string, name?: string }] }',
          },
          script: {
            type: Type.STRING,
            description: `(Advanced) Inline JS orchestration script. Use this only for complex custom orchestration. For simple batch-parallel tasks, prefer name: "batch-parallel".`,
          },
          description: {
            type: Type.STRING,
            description: 'Short description of the workflow for UI display (3-8 words).',
          },
          max_concurrency: {
            type: Type.NUMBER,
            description: 'Maximum parallel sub-agents. Default: 6. Lower to reduce API pressure.',
            minimum: 1,
            maximum: 16,
          },
          max_agents: {
            type: Type.NUMBER,
            description: 'Hard limit on total sub-agents this workflow may spawn. Default: 1000.',
            minimum: 1,
            maximum: 1000,
          },
        },
        required: ['description'],
      },
      true,  // isOutputMarkdown
      false, // forceMarkdown
      true,  // canUpdateOutput
      false, // allowSubAgentUse — prevent recursive workflow invocation
    );
  }

  validateToolParams(params: WorkflowToolParams): string | null {
    // When using a built-in (name), script may be absent — we already resolved it
    // in execute(). Only validate the script field when it's the inline path.
    if (!params.name && !params.script?.trim()) {
      return 'either `name` (a built-in workflow) or `script` is required and must not be empty.';
    }
    if (!params.description?.trim()) {
      return 'description is required.';
    }
    if (
      params.max_concurrency !== undefined &&
      (params.max_concurrency < 1 || params.max_concurrency > 16)
    ) {
      return 'max_concurrency must be between 1 and 16.';
    }
    // Sanity check: script must contain some form of export default (inline path only)
    if (params.script && !/export\s+default/.test(params.script)) {
      return 'script must export a default async function. Example: `export default async function(agent) { ... }`';
    }
    return null;
  }

  async shouldConfirmExecute(
    params: WorkflowToolParams,
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const meta = extractMeta(params.script ?? '');
    const details: ToolWorkflowConfirmationDetails = {
      type: 'workflow',
      title: 'Run a dynamic workflow?',
      description: meta.description ?? params.description,
      phases: (meta.phases ?? []).map(p => ({ name: p.title, description: p.detail ?? '' })),
      rawScript: params.script ?? (params.name ? `// built-in: ${params.name}` : ''),
      onConfirm: async (_outcome: ToolConfirmationOutcome) => {
        // The scheduler handles the outcome — Cancel stops execution,
        // any proceed outcome continues. Nothing extra needed here.
      },
    };
    return details;
  }

  getDescription(params: WorkflowToolParams): string {
    return params.description;
  }

  toolLocations(_params: WorkflowToolParams): Array<{ path: string; type: 'file' | 'directory' }> {
    // No fixed file locations — sub-agents will declare their own
    return [];
  }

  async execute(
    params: WorkflowToolParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    _services?: ToolExecutionServices,
  ): Promise<ToolResult> {
    // ─── Resolve built-in workflow (name) OR inline script ──────────────────
    let script: string;
    let effectiveWorktreeMode = params.worktree_mode ?? false;

    if (params.name) {
      if (params.script) {
        return {
          llmContent: 'Workflow error: provide either `name` (a built-in) or `script` (inline), not both.',
          returnDisplay: '**Workflow Error:** Provide either `name` or `script`, not both.',
        };
      }
      const resolved = resolveBuiltinWorkflow(params.name, params.args);
      if (!resolved) {
        const known = listBuiltinWorkflows().join(', ') || '(none)';
        return {
          llmContent: `Unknown built-in workflow "${params.name}". Known: ${known}.`,
          returnDisplay: `**Workflow Error:** Unknown built-in workflow "${params.name}". Known: ${known}.`,
        };
      }
      script = resolved.script;
      if (resolved.autoWorktree) effectiveWorktreeMode = true;
    } else if (params.script) {
      script = params.script;
    } else {
      const known = listBuiltinWorkflows().join(', ') || '(none)';
      return {
        llmContent:
          `Workflow requires either \`name\` (a built-in) or \`script\` (inline).\n` +
          `Available built-ins: ${known}`,
        returnDisplay: '**Workflow Error:** Requires either `name` or `script`.',
      };
    }

    const validationError = this.validateToolParams({ ...params, script });
    if (validationError) {
      return {
        llmContent: `Workflow parameter validation failed: ${validationError}`,
        returnDisplay: `**Workflow Error:** ${validationError}`,
      };
    }

    const geminiClient = this.config.getGeminiClient();
    if (!geminiClient) {
      return {
        llmContent: 'Workflow failed: GeminiClient not initialized.',
        returnDisplay: '**Workflow Error:** GeminiClient not initialized.',
      };
    }

    const workflowId = `wf-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    updateOutput?.(`**Workflow started:** ${params.description}\n`);

    // Register with the workflow registry — use meta if available
    const meta = extractMeta(script);
    const phases = (meta.phases ?? []).map(p => ({ name: p.title, description: p.detail ?? '' }));
    const description = meta.description ?? params.description;
    WorkflowRegistry.startWorkflow(workflowId, description, phases);

    // Track sub-agent events so we can surface them in the output stream
    const onUpdate = (agentId: string, output: string) => {
      updateOutput?.(`WORKFLOW_AGENT_UPDATE:${agentId}:${output}`);
    };

    const bridge = new WorkflowAgentBridge(
      this.config,
      this.toolRegistry,
      geminiClient,
      signal,
      onUpdate,
      params.max_concurrency,
      workflowId,
      params.max_agents,
    );

    // Propagate worktree_mode so every sub-agent gets isolated by default.
    if (effectiveWorktreeMode) {
      bridge.setWorktreeMode(true);
    }

    const runResult = await runWorkflowScript(script, bridge, signal);

    if (runResult.success) {
      WorkflowRegistry.endWorkflow(workflowId, 'completed', runResult.totalTokenUsage);

      const tokenSummary =
        `Input: ${runResult.totalTokenUsage.inputTokens}, ` +
        `Output: ${runResult.totalTokenUsage.outputTokens}, ` +
        `Total: ${runResult.totalTokenUsage.totalTokens}`;

      const display =
        `**Workflow completed:** ${params.description}\n\n` +
        `${runResult.output}\n\n` +
        `*Token usage — ${tokenSummary}*`;

      updateOutput?.(display);

      return {
        llmContent: `Workflow completed: ${runResult.output}`,
        returnDisplay: display,
      };
    } else {
      // Always record token usage even on failure — completed agents' data is valuable
      WorkflowRegistry.endWorkflow(workflowId, 'failed', runResult.totalTokenUsage);

      const display =
        `**Workflow failed:** ${params.description}\n\n` +
        `Error: ${runResult.error ?? 'unknown error'}`;

      updateOutput?.(display);

      return {
        llmContent: `Workflow failed: ${runResult.error}\n\nDo NOT attempt to complete this task manually or inline — report the workflow error to the user and stop.`,
        returnDisplay: display,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (extractWorkflowPhases removed — now using extractMeta from workflowRunner.ts)
// ─────────────────────────────────────────────────────────────────────────────
