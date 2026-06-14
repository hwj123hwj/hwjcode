/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Detect locally-installed external coding agents (Claude Code, Codex) and
 * build the spawn spec to drive them as ACP backends.
 *
 * The external agents don't speak ACP natively — they're driven through
 * community/official bridges spawned via `npx`, exactly like the CLI's Feishu
 * gateway does (see `packages/cli/src/services/feishu/localAgentDetection.ts`
 * for detection and `packages/core/src/acp-client/externalAgentRegistry.ts`
 * for the spawn specs — kept in sync with this file). Because the bridges
 * expose standard ACP over stdio, the desktop drives them with the very same
 * {@link AcpSessionBridge} client it uses for `easycode --acp`; only the
 * spawned command changes.
 */

import { execFile } from 'node:child_process';
import type { AgentKind, ExternalAgentAvailability } from '../shared/ipc.js';
import type { BackendSpec } from './backendLocator.js';

/** Bins we probe for, mapped to the availability flags. */
const BINS = {
  claudeCode: 'claude',
  codex: 'codex',
} as const;

/**
 * Per-agent env var that overrides the spawn command (whitespace-split into
 * command + args), mirroring the CLI registry's OVERRIDE_ENV. Lets users pin a
 * version or point at a local bridge build without code changes.
 */
const OVERRIDE_ENV: Record<'claude-code' | 'codex', string> = {
  'claude-code': 'EASYCODE_CLAUDE_CODE_ACP_CMD',
  codex: 'EASYCODE_CODEX_ACP_CMD',
};

/** Default `npx` bridge invocations, in sync with the core registry. */
const DEFAULT_BRIDGE: Record<'claude-code' | 'codex', { label: string; args: string[] }> = {
  'claude-code': {
    label: 'Claude Code',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  codex: {
    label: 'Codex',
    args: ['-y', '@zed-industries/codex-acp'],
  },
};

/**
 * Probe PATH for Claude Code and Codex. Always resolves — never throws — even
 * if the platform lookup tool is missing. Spawns `where` (Windows) / `which`
 * (POSIX) with a short timeout so a slow PATH scan can't stall the new-session
 * dialog.
 */
export async function detectExternalAgents(): Promise<ExternalAgentAvailability> {
  const [claudeCode, codex] = await Promise.all([
    lookup(BINS.claudeCode),
    lookup(BINS.codex),
  ]);
  return { claudeCode, codex };
}

function lookup(bin: string): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    try {
      execFile(cmd, [bin], { timeout: 1500, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(false);
        resolve(typeof stdout === 'string' && stdout.trim().length > 0);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Build the spawn spec for an external agent. `easy-code` is not an external
 * agent — callers must route it to `buildBackendSpec()` instead.
 *
 * The bridge runs via `npx`, which on Windows resolves to `npx.cmd` and
 * therefore needs a shell. The user's full env is inherited by the spawner so
 * the bridge can reuse the local Claude Code / Codex credentials.
 */
export function buildExternalAgentSpec(kind: Exclude<AgentKind, 'easy-code'>): BackendSpec {
  const def = DEFAULT_BRIDGE[kind];
  const override = process.env[OVERRIDE_ENV[kind]]?.trim();
  if (override) {
    const [command, ...args] = override.split(/\s+/);
    if (command) {
      return {
        command,
        args,
        env: {},
        description: `${def.label} (override: ${override})`,
        shell: process.platform === 'win32',
      };
    }
  }
  return {
    command: 'npx',
    args: [...def.args],
    env: {},
    description: `${def.label} via npx ${def.args.join(' ')}`,
    shell: process.platform === 'win32',
  };
}
