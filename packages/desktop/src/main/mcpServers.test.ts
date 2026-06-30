/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Covers the desktop MCP-server manager's read/write against the shared
 * `~/.easycode-user/settings.json` (`mcpServers` map + `excludeMCPServers`
 * list). fs + os are mocked with an in-memory store so the test never touches
 * the real disk or the user's home directory — mirrors the modelOverrides test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';

// In-memory file store keyed by absolute path.
const store: Record<string, string> = {};

vi.mock('node:os', () => ({ homedir: () => '/home/tester' }));

vi.mock('node:fs', () => ({
  existsSync: (p: string) => Object.prototype.hasOwnProperty.call(store, p),
  readFileSync: (p: string) => {
    if (!(p in store)) throw new Error(`ENOENT: ${p}`);
    return store[p];
  },
  writeFileSync: (p: string, data: string) => {
    store[p] = data;
  },
  renameSync: (from: string, to: string) => {
    store[to] = store[from];
    delete store[from];
  },
  mkdirSync: () => undefined,
  unlinkSync: (p: string) => {
    delete store[p];
  },
}));

import {
  listMcpServers,
  saveMcpServer,
  deleteMcpServer,
  setMcpServerEnabled,
} from './mcpServers.js';

const SETTINGS_PATH = path.join('/home/tester', '.easycode-user', 'settings.json');

function seed(json: Record<string, unknown>): void {
  store[SETTINGS_PATH] = JSON.stringify(json);
}

function readBack(): Record<string, unknown> {
  return JSON.parse(store[SETTINGS_PATH]);
}

describe('desktop mcpServers — shared settings.json manager', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  it('returns an empty list when there is no settings file', () => {
    expect(listMcpServers()).toEqual([]);
  });

  it('derives transport + enabled state from the stored config', () => {
    seed({
      mcpServers: {
        local: { command: 'node', args: ['server.js'] },
        sse: { url: 'https://example.com/sse' },
        http: { httpUrl: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
      },
      excludeMCPServers: ['sse'],
    });

    const list = listMcpServers();
    const byName = Object.fromEntries(list.map((s) => [s.name, s]));

    expect(byName.local.transport).toBe('stdio');
    expect(byName.local.command).toBe('node');
    expect(byName.local.args).toEqual(['server.js']);
    expect(byName.local.enabled).toBe(true);

    expect(byName.sse.transport).toBe('sse');
    expect(byName.sse.url).toBe('https://example.com/sse');
    expect(byName.sse.enabled).toBe(false); // in excludeMCPServers

    expect(byName.http.transport).toBe('http');
    expect(byName.http.httpUrl).toBe('https://example.com/mcp');
    expect(byName.http.headers).toEqual({ Authorization: 'Bearer x' });
  });

  it('adds a stdio server, preserving unrelated settings keys', () => {
    seed({ theme: 'dark', preferredLanguage: '中文' });

    const res = saveMcpServer({
      name: 'fetch',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
      env: { API_KEY: '${API_KEY}' },
      timeout: 30000,
      trust: true,
      description: 'Fetch tool',
    });

    expect(res.ok).toBe(true);
    const raw = readBack();
    expect(raw.theme).toBe('dark');
    expect(raw.preferredLanguage).toBe('中文');
    expect(raw.mcpServers).toEqual({
      fetch: {
        command: 'uvx',
        args: ['mcp-server-fetch'],
        env: { API_KEY: '${API_KEY}' },
        timeout: 30000,
        trust: true,
        description: 'Fetch tool',
      },
    });
  });

  it('validates required fields per transport', () => {
    expect(saveMcpServer({ name: '', transport: 'stdio', command: 'x' }).ok).toBe(false);
    expect(saveMcpServer({ name: 'a', transport: 'stdio' }).ok).toBe(false); // no command
    expect(saveMcpServer({ name: 'b', transport: 'sse' }).ok).toBe(false); // no url
    expect(saveMcpServer({ name: 'c', transport: 'http' }).ok).toBe(false); // no httpUrl
    // none of the invalid saves should have written a file
    expect(store[SETTINGS_PATH]).toBeUndefined();
  });

  it('rejects adding a server whose name already exists', () => {
    seed({ mcpServers: { dup: { command: 'node' } } });
    const res = saveMcpServer({ name: 'dup', transport: 'stdio', command: 'other' });
    expect(res.ok).toBe(false);
    // original config untouched
    expect((readBack().mcpServers as Record<string, unknown>).dup).toEqual({ command: 'node' });
  });

  it('edits in place when originalName matches the name (overwrite allowed)', () => {
    seed({ mcpServers: { srv: { command: 'node', args: ['old.js'] } } });
    const res = saveMcpServer(
      { name: 'srv', transport: 'stdio', command: 'node', args: ['new.js'] },
      'srv',
    );
    expect(res.ok).toBe(true);
    expect((readBack().mcpServers as Record<string, Record<string, unknown>>).srv.args).toEqual([
      'new.js',
    ]);
  });

  it('migrates the key and its disabled state on rename', () => {
    seed({
      mcpServers: { old: { command: 'node' } },
      excludeMCPServers: ['old'],
    });

    const res = saveMcpServer(
      { name: 'new', transport: 'stdio', command: 'node' },
      'old',
    );
    expect(res.ok).toBe(true);

    const raw = readBack();
    const servers = raw.mcpServers as Record<string, unknown>;
    expect('old' in servers).toBe(false);
    expect('new' in servers).toBe(true);
    // disabled state followed the rename
    expect(raw.excludeMCPServers).toEqual(['new']);
  });

  it('removes a server from both the map and the disabled list on delete', () => {
    seed({
      mcpServers: { a: { command: 'node' }, b: { url: 'https://x' } },
      excludeMCPServers: ['a'],
    });

    deleteMcpServer('a');

    const raw = readBack();
    expect(raw.mcpServers).toEqual({ b: { url: 'https://x' } });
    // excludeMCPServers became empty → key dropped entirely
    expect('excludeMCPServers' in raw).toBe(false);
  });

  it('toggles excludeMCPServers membership via setMcpServerEnabled', () => {
    seed({ mcpServers: { s: { command: 'node' } } });

    // disable → added to the list
    setMcpServerEnabled('s', false);
    expect(readBack().excludeMCPServers).toEqual(['s']);
    expect(listMcpServers()[0].enabled).toBe(false);

    // re-enable → removed, empty list dropped
    setMcpServerEnabled('s', true);
    expect('excludeMCPServers' in readBack()).toBe(false);
    expect(listMcpServers()[0].enabled).toBe(true);
  });

  it('honours the enabled flag passed to saveMcpServer', () => {
    saveMcpServer({ name: 's', transport: 'stdio', command: 'node', enabled: false });
    expect(readBack().excludeMCPServers).toEqual(['s']);

    saveMcpServer({ name: 's', transport: 'stdio', command: 'node', enabled: true }, 's');
    expect('excludeMCPServers' in readBack()).toBe(false);
  });

  it('drops empty optional fields from the written stdio config', () => {
    saveMcpServer({
      name: 's',
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      cwd: '   ',
      description: '',
    });
    expect((readBack().mcpServers as Record<string, unknown>).s).toEqual({ command: 'node' });
  });
});
