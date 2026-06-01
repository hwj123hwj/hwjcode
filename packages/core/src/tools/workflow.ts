/**
 * @license
 * Copyright 2025 DeepV Code team
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
import { runWorkflowScript } from '../core/workflowRunner.js';
import { ToolExecutionContext } from '../core/toolSchedulerAdapter.js';
import { WorkflowRegistry } from '../core/workflowRegistry.js';

export interface WorkflowToolParams {
  /**
   * A JavaScript orchestration script that drives the workflow.
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
  script: string;

  /** Short human-readable description for UI display (3-8 words). */
  description: string;

  /**
   * Maximum number of sub-agents that may run concurrently.
   * Defaults to 6. Set lower to reduce API quota pressure.
   */
  max_concurrency?: number;
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

Use this tool when the task:
- Requires parallel analysis or execution across many files/modules
- Has dependent steps where later agents need structured results from earlier ones
- Is too large or complex for a single sub-agent or linear tool calls
- Matches patterns like: codebase-wide audits, large migrations, cross-module refactors, deep research

Trigger: include "workflow" in the user's prompt, or invoke directly for complex tasks.

Script API (available inside the script as the \`agent\` argument):
- \`agent.run({ prompt, context?, agent_type?, max_turns?, model? })\` — run one sub-agent, returns \`{ success, result, data? }\`
  - \`model\`: optional model override, e.g. \`'gemini-2.0-flash'\` for fast/cheap steps, \`'gemini-2.5-pro'\` for deep reasoning steps
- \`agent.runParallel([...tasks])\` — run multiple sub-agents concurrently, returns results in input order
- \`agent.setPhase(index)\` — IMPORTANT: call before each phase to update the UI tracker (0-based index). Example: \`agent.setPhase(0)\` before first phase, \`agent.setPhase(1)\` before second phase.

Context passing: set \`context\` to any JSON-serializable value from a previous step. It will be injected into the sub-agent prompt so the sub-agent can use prior results immediately.

Sub-agent result: \`result\` is the sub-agent's text summary. \`data\` is auto-parsed JSON if the sub-agent returned a JSON block in its final response.`,
      Icon.Tasks,
      {
        type: Type.OBJECT,
        properties: {
          script: {
            type: Type.STRING,
            description: `JavaScript orchestration script. Must export a default async function(agent).
Script has access to: agent.run(), agent.runParallel(), JSON, console.log.
Script does NOT have access to: require, import, fs, process, fetch, or any Node.js globals.
The script is the source of truth for task decomposition, branching, and result aggregation.`,
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
        },
        required: ['script', 'description'],
      },
      true,  // isOutputMarkdown
      false, // forceMarkdown
      true,  // canUpdateOutput
      false, // allowSubAgentUse — prevent recursive workflow invocation
    );
  }

  validateToolParams(params: WorkflowToolParams): string | null {
    if (!params.script?.trim()) {
      return 'script is required and must not be empty.';
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
    // Sanity check: script must contain some form of export default
    if (!/export\s+default/.test(params.script)) {
      return 'script must export a default async function. Example: `export default async function(agent) { ... }`';
    }
    return null;
  }

  async shouldConfirmExecute(
    params: WorkflowToolParams,
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const details: ToolWorkflowConfirmationDetails = {
      type: 'workflow',
      title: 'Run a dynamic workflow?',
      description: params.description,
      phases: extractWorkflowPhases(params.script),
      rawScript: params.script,
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
    const validationError = this.validateToolParams(params);
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

    // Register with the workflow registry so /workflow panel can track it
    const phases = extractWorkflowPhases(params.script);
    WorkflowRegistry.startWorkflow(workflowId, params.description, phases);

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
    );

    const runResult = await runWorkflowScript(params.script, bridge, signal);

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
      WorkflowRegistry.endWorkflow(workflowId, 'failed');

      const display =
        `**Workflow failed:** ${params.description}\n\n` +
        `Error: ${runResult.error ?? 'unknown error'}`;

      updateOutput?.(display);

      return {
        llmContent: `Workflow failed: ${runResult.error}`,
        returnDisplay: display,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Script analysis helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract high-level phases from the orchestration script for the confirmation
 * dialog preview. Looks for comment blocks like:
 *   // Phase 1: Name — description
 *   // Step 2: Name — description
 *   // === Name ===
 * and falls back to extracting `agent.run` / `agent.runParallel` call sites.
 */
function extractWorkflowPhases(script: string): WorkflowPhase[] {
  const phases: WorkflowPhase[] = [];

  // 1. Try to find explicit phase/step comments
  const phaseCommentRe =
    /\/\/\s*(?:Phase|Step|阶段|步骤)\s*\d*[:\s.]\s*([^\n—-]+?)(?:[—-]\s*([^\n]+))?$/gim;
  let m: RegExpExecArray | null;
  while ((m = phaseCommentRe.exec(script)) !== null) {
    phases.push({
      name: m[1]!.trim(),
      description: m[2]?.trim() ?? '',
    });
  }

  if (phases.length > 0) {
    // Attach up to 3 agent prompt previews per phase (not trivial to map, so do it globally)
    attachAgentPreviews(script, phases);
    return phases.slice(0, 6);
  }

  // 2. Fallback: extract agent.run / agent.runParallel call sites
  const runRe = /await\s+agent\.(run|runParallel)\s*\(\s*(?:\[?\s*)?{[^}]*prompt\s*:\s*['"`]([\s\S]*?)['"`]/g;
  const seen = new Set<string>();
  while ((m = runRe.exec(script)) !== null) {
    const isParallel = m[1] === 'runParallel';
    const prompt = m[2]!.slice(0, 80).replace(/\n/g, ' ');
    if (!seen.has(prompt)) {
      seen.add(prompt);
      phases.push({
        name: isParallel ? '并行执行' : '串行执行',
        description: prompt + (m[2]!.length > 80 ? '…' : ''),
      });
    }
    if (phases.length >= 6) break;
  }

  if (phases.length === 0) {
    // Ultimate fallback: single generic phase
    phases.push({ name: '执行', description: '运行工作流脚本' });
  }

  return phases;
}

function attachAgentPreviews(script: string, phases: WorkflowPhase[]): void {
  // Collect all agent prompt strings globally and distribute across phases
  const promptRe = /prompt\s*:\s*['"`]([\s\S]*?)['"`]/g;
  const allPrompts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = promptRe.exec(script)) !== null) {
    allPrompts.push(m[1]!.slice(0, 60).replace(/\n/g, ' ') + (m[1]!.length > 60 ? '…' : ''));
    if (allPrompts.length >= phases.length * 3) break;
  }
  const perPhase = Math.ceil(allPrompts.length / Math.max(phases.length, 1));
  phases.forEach((phase, i) => {
    phase.agentPreviews = allPrompts.slice(i * perPhase, i * perPhase + 3);
  });
}
