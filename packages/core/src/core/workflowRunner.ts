/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import { WorkflowAgentAPI } from './workflowAgentBridge.js';

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
 * Execute a workflow orchestration script inside a Node.js vm sandbox.
 *
 * Security model:
 * - The script runs in a completely fresh context with no access to the host
 *   module system (no require, no import, no process, no fs).
 * - Only the `agent` object and a subset of safe globals (JSON, console.log)
 *   are injected.
 * - The script MUST export a default async function: `export default async function(agent) {...}`
 *   This is transpiled server-side to a CommonJS-compatible wrapper before execution.
 *
 * Script contract:
 * - Call `await agent.run({...})` for serial execution.
 * - Call `await agent.runParallel([...])` for parallel execution.
 * - Return a string (or JSON-serializable value) as the final workflow output.
 * - The script should not catch AbortSignal errors — let them propagate.
 */
export async function runWorkflowScript(
  script: string,
  agentAPI: WorkflowAgentAPI,
  abortSignal: AbortSignal,
): Promise<WorkflowRunResult> {
  const tokenAccumulator = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  // Wrap the agent API to accumulate token usage transparently
  const wrappedAgent: WorkflowAgentAPI = {
    async run(options) {
      const result = await agentAPI.run(options);
      if (result.tokenUsage) {
        tokenAccumulator.inputTokens += result.tokenUsage.inputTokens;
        tokenAccumulator.outputTokens += result.tokenUsage.outputTokens;
        tokenAccumulator.totalTokens += result.tokenUsage.totalTokens;
      }
      return result;
    },
    async runParallel(tasks) {
      const results = await agentAPI.runParallel(tasks);
      for (const r of results) {
        if (r.tokenUsage) {
          tokenAccumulator.inputTokens += r.tokenUsage.inputTokens;
          tokenAccumulator.outputTokens += r.tokenUsage.outputTokens;
          tokenAccumulator.totalTokens += r.tokenUsage.totalTokens;
        }
      }
      return results;
    },
  };

  // Transpile "export default async function" to a module.exports assignment
  // so it runs in a CommonJS-style vm context.
  const transpiled = transpileScript(script);

  // Logs produced by the script are captured and available for debugging
  const capturedLogs: string[] = [];
  const safeConsole = {
    log: (...args: unknown[]) => {
      capturedLogs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    },
  };

  const sandbox: Record<string, unknown> = {
    agent: wrappedAgent,
    console: safeConsole,
    JSON,
    module: { exports: {} as Record<string, unknown> },
    exports: {} as Record<string, unknown>,
    __capturedLogs: capturedLogs,
  };

  try {
    // Compile and run the script body (registers module.exports.default)
    const vmScript = new vm.Script(transpiled, { filename: 'workflow.js' });
    const context = vm.createContext(sandbox);
    vmScript.runInContext(context);

    // Retrieve the exported default function
    const exports = sandbox['module'] as { exports: Record<string, unknown> };
    const mainFn = exports.exports['default'];
    if (typeof mainFn !== 'function') {
      throw new Error(
        'Workflow script must export a default async function: `export default async function(agent) { ... }`',
      );
    }

    // Execute the orchestration function
    const rawOutput = await (mainFn as (agent: WorkflowAgentAPI) => Promise<unknown>)(wrappedAgent);

    // Coerce the return value to a string
    const output =
      typeof rawOutput === 'string'
        ? rawOutput
        : rawOutput !== undefined && rawOutput !== null
          ? JSON.stringify(rawOutput, null, 2)
          : '(workflow completed with no return value)';

    return {
      success: true,
      output,
      totalTokenUsage: tokenAccumulator,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Re-throw abort errors so the caller can handle them
    if (errorMessage.includes('abort') || errorMessage.includes('cancel') || abortSignal.aborted) {
      throw err;
    }

    return {
      success: false,
      output: '',
      error: errorMessage,
      totalTokenUsage: tokenAccumulator,
    };
  }
}

/**
 * Minimal transpiler: converts ES module syntax used in workflow scripts to
 * CommonJS-style assignments that work inside a vm.Script context.
 *
 * Handles:
 *   export default async function(agent) { ... }
 *   export default async function myFn(agent) { ... }
 *   export default function(agent) { ... }
 *
 * Everything else is passed through unchanged — the script author is responsible
 * for not using unsupported syntax (import, require, etc.).
 */
function transpileScript(script: string): string {
  let result = script;

  // "export default async function [name]?(" → "module.exports.default = async function("
  // Handles both named and anonymous async functions.
  result = result.replace(
    /export\s+default\s+async\s+function\s*\w*\s*\(/g,
    'module.exports.default = async function(',
  );

  // "export default function [name]?(" → "module.exports.default = function("
  // Handles both named and anonymous functions.
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
