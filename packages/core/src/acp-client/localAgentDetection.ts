/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Detect whether `claude` (Claude Code) and/or `codex` (OpenAI Codex CLI) are
 * installed on the user's machine and resolvable on PATH.
 *
 * Used by the tool registration layer (`config.ts`) to decide whether to
 * register the `delegate_to_agent` tool at all, and by the tool's `execute()`
 * method to give the AI a clear "agent not installed" message instead of
 * silently pretending the task was dispatched.
 *
 * The check shells out to `where` (Windows) or `which` (POSIX). Failures of
 * any kind (missing binary, timeout, permission error) are interpreted as
 * "not available" — we never let detection failure crash the startup flow.
 *
 * Users can override the ACP bridge command via environment variables
 * (`EASYCODE_CLAUDE_CODE_ACP_CMD` / `EASYCODE_CODEX_ACP_CMD`). When set, the
 * agent is considered available even if the bare binary is not on PATH,
 * because the override may point to a custom bridge that doesn't require the
 * CLI tool itself.
 */

import { execFile } from 'node:child_process';
import type { ExternalAgentType } from './externalAgentRegistry.js';

/** Result of probing the user's machine for known local coding agents. */
export interface LocalAgentAvailability {
  /** True when `claude` resolves on PATH or override env is set. */
  claudeCode: boolean;
  /** True when `codex` resolves on PATH or override env is set. */
  codex: boolean;
}

export interface DetectLocalAgentsDeps {
  /**
   * Bin lookup function. Returns true iff the named binary is found on PATH.
   * Defaults to a spawn-based implementation using `where`/`which`.
   * Tests should inject a fake.
   */
  lookup?: (bin: string) => Promise<boolean>;
  /**
   * Environment record for checking override variables. Defaults to
   * `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

/** Bins we care about, keyed by ExternalAgentType. */
const BINS: Record<ExternalAgentType, string> = {
  'claude-code': 'claude',
  codex: 'codex',
};

/** Environment variables that can override the ACP bridge command. */
const OVERRIDE_ENV: Record<ExternalAgentType, string> = {
  'claude-code': 'EASYCODE_CLAUDE_CODE_ACP_CMD',
  codex: 'EASYCODE_CODEX_ACP_CMD',
};

/**
 * Probe for the local presence of Claude Code and Codex CLI. Always resolves
 * — never throws — even if the platform lookup tool is missing.
 *
 * An agent is considered "available" if EITHER:
 * 1. Its binary is found on PATH (`where`/`which`), OR
 * 2. Its override environment variable is set (custom bridge).
 */
export async function detectLocalAgents(
  deps: DetectLocalAgentsDeps = {},
): Promise<LocalAgentAvailability> {
  const lookup = deps.lookup ?? defaultLookup;
  const env = deps.env ?? process.env;

  // Run in parallel; any per-bin failure resolves to `false`.
  const [claudeCode, codex] = await Promise.all([
    isAgentAvailable('claude-code', lookup, env),
    isAgentAvailable('codex', lookup, env),
  ]);
  return { claudeCode, codex };
}

/**
 * Check whether a specific agent type is available.
 */
export async function isAgentAvailable(
  type: ExternalAgentType,
  lookup: (bin: string) => Promise<boolean> = defaultLookup,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  // Override env var set → consider available (custom bridge).
  if (env[OVERRIDE_ENV[type]]?.trim()) {
    return true;
  }
  return safeLookup(lookup, BINS[type]);
}

/**
 * Whether ANY external agent is available. Used by the registration layer
 * to decide whether to register the delegate tool at all.
 */
export async function hasAnyLocalAgent(
  deps: DetectLocalAgentsDeps = {},
): Promise<boolean> {
  const { claudeCode, codex } = await detectLocalAgents(deps);
  return claudeCode || codex;
}

async function safeLookup(
  lookup: (bin: string) => Promise<boolean>,
  bin: string,
): Promise<boolean> {
  try {
    return await lookup(bin);
  } catch {
    return false;
  }
}

/**
 * Default lookup: spawns `where <bin>` on Windows or `which <bin>` on POSIX
 * and treats a 0 exit code as "found". A 1500ms timeout caps how long the
 * startup can be delayed by a slow PATH scan.
 */
async function defaultLookup(bin: string): Promise<boolean> {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(
      cmd,
      [bin],
      { timeout: 1500, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(typeof stdout === 'string' && stdout.trim().length > 0);
      },
    );
  });
}
