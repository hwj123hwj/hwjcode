/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * MCP-server management for the desktop app.
 *
 * MCP servers live in the same shared store the CLI uses —
 * `~/.easycode-user/settings.json` under the `mcpServers` key — the very map the
 * CLI's `/mcp` flow and every spawned `easycode --acp` backend read on session
 * start. A server added/edited here is therefore loaded by the next created
 * session. This mirrors `userSettings.ts`/`customModels.ts` but stands alone so
 * the main process doesn't drag in the CLI package.
 *
 * Enable/disable is modelled as membership in the sibling `excludeMCPServers`
 * array, which core honours natively when assembling a session's MCP set (see
 * `mergeMcpServers` + the `excludeMCPServers` filter in the CLI's
 * `loadCliConfig`). Disabling a server thus keeps its full config on disk but
 * stops the next session from loading it — the desktop counterpart of the
 * VSCode plugin's per-server toggle, expressed through shared settings rather
 * than an in-process tool filter (the desktop's backend is a separate process).
 *
 * We deliberately read-modify-write the *whole* JSON object so every key the
 * desktop doesn't surface (theme, hooks, customModels, …) is preserved untouched.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type {
  McpServerEntry,
  McpServerInput,
  McpTransport,
  SaveMcpServerResult,
} from '../shared/ipc.js';

const SETTINGS_DIRECTORY_NAME = '.easycode-user';
const SETTINGS_FILE = 'settings.json';

function filePath(): string {
  return path.join(homedir(), SETTINGS_DIRECTORY_NAME, SETTINGS_FILE);
}

/** Read the full settings object from disk; never throws (returns {} on failure). */
function readRaw(): Record<string, unknown> {
  try {
    const fp = filePath();
    if (!fs.existsSync(fp)) return {};
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    console.warn('[mcpServers] Failed to read settings.json:', err);
    return {};
  }
}

/** Atomic write (temp file + rename), matching the CLI's storage discipline. */
function writeRaw(data: Record<string, unknown>): void {
  const fp = filePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
}

function asRecord(value: unknown): Record<string, Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Record<string, unknown>>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Which connection field a stored config carries decides its transport. */
function deriveTransport(cfg: Record<string, unknown>): McpTransport {
  if (typeof cfg.httpUrl === 'string') return 'http';
  if (typeof cfg.url === 'string') return 'sse';
  return 'stdio';
}

/** Project a stored config + enabled flag into the renderer-facing entry. */
function toEntry(name: string, cfg: Record<string, unknown>, enabled: boolean): McpServerEntry {
  const transport = deriveTransport(cfg);
  return {
    name,
    transport,
    enabled,
    command: typeof cfg.command === 'string' ? cfg.command : undefined,
    args: Array.isArray(cfg.args) ? (cfg.args as string[]) : undefined,
    env: cfg.env && typeof cfg.env === 'object' ? (cfg.env as Record<string, string>) : undefined,
    cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
    url: typeof cfg.url === 'string' ? cfg.url : undefined,
    httpUrl: typeof cfg.httpUrl === 'string' ? cfg.httpUrl : undefined,
    headers:
      cfg.headers && typeof cfg.headers === 'object'
        ? (cfg.headers as Record<string, string>)
        : undefined,
    timeout: typeof cfg.timeout === 'number' ? cfg.timeout : undefined,
    trust: typeof cfg.trust === 'boolean' ? cfg.trust : undefined,
    description: typeof cfg.description === 'string' ? cfg.description : undefined,
  };
}

/** List the configured MCP servers, each tagged with its enabled state. */
export function listMcpServers(): McpServerEntry[] {
  const raw = readRaw();
  const servers = asRecord(raw.mcpServers);
  const disabled = new Set(asStringArray(raw.excludeMCPServers));
  return Object.entries(servers).map(([name, cfg]) => toEntry(name, cfg, !disabled.has(name)));
}

/** Validate an input; returns an error message, or null when valid. */
function validate(input: McpServerInput, name: string): string | null {
  if (!name) return 'Server name is required';
  if (input.transport === 'stdio' && !input.command?.trim()) {
    return 'Command is required for stdio transport';
  }
  if (input.transport === 'sse' && !input.url?.trim()) {
    return 'URL is required for SSE transport';
  }
  if (input.transport === 'http' && !input.httpUrl?.trim()) {
    return 'URL is required for HTTP transport';
  }
  return null;
}

/** Build the on-disk config for an input, dropping empty optional fields. */
function buildConfig(input: McpServerInput): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};

  if (input.transport === 'stdio') {
    cfg.command = input.command!.trim();
    if (input.args && input.args.length > 0) cfg.args = input.args;
    if (input.env && Object.keys(input.env).length > 0) cfg.env = input.env;
    if (input.cwd?.trim()) cfg.cwd = input.cwd.trim();
  } else if (input.transport === 'sse') {
    cfg.url = input.url!.trim();
    if (input.headers && Object.keys(input.headers).length > 0) cfg.headers = input.headers;
  } else {
    cfg.httpUrl = input.httpUrl!.trim();
    if (input.headers && Object.keys(input.headers).length > 0) cfg.headers = input.headers;
  }

  if (typeof input.timeout === 'number' && input.timeout > 0) cfg.timeout = input.timeout;
  if (input.trust === true) cfg.trust = true;
  if (input.description?.trim()) cfg.description = input.description.trim();

  return cfg;
}

/**
 * Add `name` to (or remove it from) the shared `excludeMCPServers` list so the
 * next created session honours the disabled state. Drops the key entirely when
 * the list becomes empty.
 */
function applyExcluded(raw: Record<string, unknown>, name: string, excluded: boolean): void {
  const list = asStringArray(raw.excludeMCPServers);
  const has = list.includes(name);
  let next: string[];
  if (excluded && !has) next = [...list, name];
  else if (!excluded && has) next = list.filter((n) => n !== name);
  else return; // no change

  if (next.length > 0) raw.excludeMCPServers = next;
  else delete raw.excludeMCPServers;
}

/**
 * Add or update an MCP server (keyed by `name`). When an edit renames the server,
 * pass the previous name as `originalName` so the old entry — and its disabled
 * state — migrate rather than orphan.
 */
export function saveMcpServer(
  input: McpServerInput,
  originalName?: string,
): SaveMcpServerResult {
  const name = input.name?.trim() ?? '';
  const error = validate(input, name);
  if (error) return { ok: false, error };

  try {
    const raw = readRaw();
    const servers = asRecord(raw.mcpServers);
    const prevName = originalName?.trim() || '';
    const isRename = !!prevName && prevName !== name;
    const isAdd = !prevName;

    // Guard against clobbering a different existing server.
    if ((isAdd || isRename) && Object.prototype.hasOwnProperty.call(servers, name)) {
      return { ok: false, error: `An MCP server named "${name}" already exists` };
    }

    if (isRename) delete servers[prevName];
    servers[name] = buildConfig(input);
    raw.mcpServers = servers;

    // Carry the disabled flag across a rename, then apply the input's enabled state.
    if (isRename) {
      const disabled = asStringArray(raw.excludeMCPServers);
      if (disabled.includes(prevName)) {
        applyExcluded(raw, prevName, false);
        applyExcluded(raw, name, true);
      }
    }
    if (typeof input.enabled === 'boolean') {
      applyExcluded(raw, name, !input.enabled);
    }

    writeRaw(raw);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove an MCP server by name, also dropping it from the disabled list. */
export function deleteMcpServer(name: string): void {
  const n = name?.trim();
  if (!n) return;
  const raw = readRaw();
  const servers = asRecord(raw.mcpServers);
  if (Object.prototype.hasOwnProperty.call(servers, n)) {
    delete servers[n];
    raw.mcpServers = servers;
  }
  applyExcluded(raw, n, false);
  writeRaw(raw);
}

/**
 * Enable/disable a server without touching its config, by toggling its presence
 * in the shared `excludeMCPServers` list. Honoured by the next created session.
 */
export function setMcpServerEnabled(name: string, enabled: boolean): void {
  const n = name?.trim();
  if (!n) return;
  const raw = readRaw();
  applyExcluded(raw, n, !enabled);
  writeRaw(raw);
}
