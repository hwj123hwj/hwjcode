/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Covers the VSCode mirror of the CLI's `modelOverrides` read/write against the
 * shared `~/.easycode-user/settings.json`. fs + os are mocked with an in-memory
 * store so the test never touches the real disk or the user's home directory.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';

// In-memory file store keyed by absolute path.
const store: Record<string, string> = {};

vi.mock('os', () => ({ homedir: () => '/home/tester' }));

vi.mock('fs', () => ({
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
}));

import { UserSettingsService } from './userSettingsService.js';

const SETTINGS_PATH = path.join('/home/tester', '.easycode-user', 'settings.json');

const stubLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
const service = UserSettingsService.getInstance(stubLogger);

function seed(json: Record<string, unknown>): void {
  store[SETTINGS_PATH] = JSON.stringify(json);
}

describe('vscode UserSettingsService — modelOverrides mirror', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  it('returns an empty object when nothing is persisted', () => {
    expect(service.getModelOverrides()).toEqual({});
  });

  it('reads valid modelOverrides from the shared settings file', () => {
    seed({ modelOverrides: { compression: 'gemini-2.5-pro', codeExpert: 'auto' } });
    expect(service.getModelOverrides()).toEqual({
      compression: 'gemini-2.5-pro',
      codeExpert: 'auto',
    });
  });

  it('writes modelOverrides while preserving unrelated keys', () => {
    seed({ theme: 'dark', preferredLanguage: '中文' });
    service.setModelOverrides({ verification: 'gemini-2.5-flash' });
    const raw = JSON.parse(store[SETTINGS_PATH]);
    expect(raw.theme).toBe('dark');
    expect(raw.preferredLanguage).toBe('中文');
    expect(raw.modelOverrides).toEqual({ verification: 'gemini-2.5-flash' });
  });

  it('clears the key when set to an empty / all-blank object', () => {
    seed({ modelOverrides: { compression: 'gemini-2.5-pro' } });
    service.setModelOverrides({});
    expect('modelOverrides' in JSON.parse(store[SETTINGS_PATH])).toBe(false);
  });

  it('strips blank/invalid override fields on write', () => {
    service.setModelOverrides({ compression: '  ', codeExpert: 'claude-sonnet-4' } as any);
    expect(JSON.parse(store[SETTINGS_PATH]).modelOverrides).toEqual({
      codeExpert: 'claude-sonnet-4',
    });
  });
});
