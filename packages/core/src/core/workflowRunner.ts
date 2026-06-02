/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import { WorkflowAgentAPI } from './workflowAgentBridge.js';

/**
 * Structured metadata parsed from `export const meta = { ... }` at the top of a workflow script.
 */
export interface WorkflowMeta {
  name?: string;
  description?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

/**
 * Result returned after the orchestration script finishes.
 */
export interface WorkflowRunResult {
  success: boolean;
  /** Final value returned by the script's default export function. */
  output: string;
  error?: string;
  /** Accumulated token usage across all sub-agents. */
  totalTokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Parse `export const meta = { ... }` from the script source without executing it.
 * Returns an empty object if no meta is found or parsing fails.
 */
export function extractMeta(script: string): WorkflowMeta {
  // Match: export const meta = { ... }; (handles multi-line JSON-like object literal)
  const match = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\});?\s*\n/);
  if (!match) return {};
  try {
    // Evaluate the object literal in a sandboxed context (no side-effects)
    const sandbox = { result: undefined as unknown };
    const evalScript = new vm.Script(`result = (${match[1]!})`);
    evalScript.runInNewContext(sandbox);
    const val = sandbox.result;
    if (val && typeof val === 'object') return val as WorkflowMeta;
  } catch {
    // ignore parse errors
  }
  return {};
}

/**
 * Execute a workflow orchestration script inside a Node.js vm sandbox.
 *
 * Script contract:
 * - Declare metadata at the top:
 *     export const meta = { name, description, phases: [{title, detail}] };
 * - Call `phase('name')` to advance the UI phase tracker.
 * - Call `await agent(prompt, { label, schema?, model? })` for serial execution.
 * - Call `await Promise.all([agent(...), agent(...)])` for parallel execution.
 * - Return a string (or JSON-serializable value) as the final workflow output.
 */
export async function runWorkflowScript(
  script: string,
  agentAPI: WorkflowAgentAPI,
  abortSignal: AbortSignal,
): Promise<WorkflowRunResult> {
  const tokenAccumulator = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  // ── phase() top-level function ────────────────────────────────────────────
  // Maps phase title → index by consulting the meta we already parsed, with fallback counter.
  const meta = extractMeta(script);
  const phaseTitles = (meta.phases ?? []).map(p => p.title);
  let currentPhaseIdx = 0;

  const phaseFunc = (title: string) => {
    // Find by title first, fall back to sequential increment
    const idx = phaseTitles.indexOf(title);
    currentPhaseIdx = idx >= 0 ? idx : currentPhaseIdx + 1;
    if ('currentPhaseIndex' in agentAPI) {
      (agentAPI as unknown as { currentPhaseIndex: number }).currentPhaseIndex = currentPhaseIdx;
    }
  };

  // ── agent() / agent.run() / agent.runParallel() ───────────────────────────
  // Support both the flat `agent(prompt, opts)` call style AND the nested
  // `agent.run({...})` / `agent.runParallel([...])` style for backwards compat.
  const runOne = async (
    promptOrOpts: string | Parameters<WorkflowAgentAPI['run']>[0],
    opts?: { label?: string; schema?: Record<string, unknown>; model?: string; context?: unknown; max_turns?: number },
  ) => {
    const options: Parameters<WorkflowAgentAPI['run']>[0] =
      typeof promptOrOpts === 'string'
        ? { prompt: promptOrOpts, label: opts?.label, schema: opts?.schema, model: opts?.model, context: opts?.context, max_turns: opts?.max_turns }
        : promptOrOpts;

    const result = await agentAPI.run(options);
    if (result.tokenUsage) {
      tokenAccumulator.inputTokens += result.tokenUsage.inputTokens;
      tokenAccumulator.outputTokens += result.tokenUsage.outputTokens;
      tokenAccumulator.totalTokens += result.tokenUsage.totalTokens;
    }
    return result;
  };

  const runParallel = async (tasks: Parameters<WorkflowAgentAPI['runParallel']>[0]) => {
    const results = await agentAPI.runParallel(tasks);
    for (const r of results) {
      if (r.tokenUsage) {
        tokenAccumulator.inputTokens += r.tokenUsage.inputTokens;
        tokenAccumulator.outputTokens += r.tokenUsage.outputTokens;
        tokenAccumulator.totalTokens += r.tokenUsage.totalTokens;
      }
    }
    return results;
  };

  // The callable `agent` function — supports both call styles
  const agentFn = Object.assign(
    async (
      promptOrOpts: string | Parameters<WorkflowAgentAPI['run']>[0],
      opts?: { label?: string; schema?: Record<string, unknown>; model?: string; context?: unknown; max_turns?: number },
    ) => runOne(promptOrOpts, opts),
    {
      run: runOne,
      runParallel,
      setPhase: (index: number) => {
        currentPhaseIdx = index;
        if ('currentPhaseIndex' in agentAPI) {
          (agentAPI as unknown as { currentPhaseIndex: number }).currentPhaseIndex = index;
        }
      },
    },
  );

  // Transpile ES module syntax to CommonJS for vm context
  const transpiled = transpileScript(script);

  const capturedLogs: string[] = [];
  const safeConsole = {
    log: (...args: unknown[]) =>
      capturedLogs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    error: (...args: unknown[]) =>
      capturedLogs.push('[error] ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
  };

  const sandbox: Record<string, unknown> = {
    agent: agentFn,
    phase: phaseFunc,          // top-level phase() function
    console: safeConsole,
    JSON,
    Promise,
    module: { exports: {} as Record<string, unknown> },
    exports: {} as Record<string, unknown>,
  };

  try {
    const vmScript = new vm.Script(transpiled, { filename: 'workflow.js' });
    const context = vm.createContext(sandbox);
    vmScript.runInContext(context);

    const exports = sandbox['module'] as { exports: Record<string, unknown> };
    const mainFn = exports.exports['default'];
    if (typeof mainFn !== 'function') {
      throw new Error(
        'Workflow script must export a default async function: `export default async function(agent) { ... }`',
      );
    }

    const rawOutput = await (mainFn as (agent: typeof agentFn) => Promise<unknown>)(agentFn);

    const output =
      typeof rawOutput === 'string'
        ? rawOutput
        : rawOutput !== undefined && rawOutput !== null
          ? JSON.stringify(rawOutput, null, 2)
          : '(workflow completed with no return value)';

    return { success: true, output, totalTokenUsage: tokenAccumulator };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (abortSignal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    return { success: false, output: '', error: errorMessage, totalTokenUsage: tokenAccumulator };
  }
}

/**
 * Transpile ES module syntax to CommonJS for vm.Script.
 * Also strips `export const meta = {...}` (it's only used by extractMeta).
 */
function transpileScript(script: string): string {
  let result = script;

  // Strip "export const meta = { ... };" — already consumed by extractMeta()
  result = result.replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\};?\s*\n/, '');

  // "export default async function [name]?(" → "module.exports.default = async function("
  result = result.replace(
    /export\s+default\s+async\s+function\s*\w*\s*\(/g,
    'module.exports.default = async function(',
  );

  // "export default function [name]?(" → "module.exports.default = function("
  result = result.replace(
    /export\s+default\s+function\s*\w*\s*\(/g,
    'module.exports.default = function(',
  );

  // "export default async (" or "export default (" — arrow function form
  result = result.replace(
    /export\s+default\s+(async\s*)?\(/g,
    'module.exports.default = $1(',
  );

  return result;
}
