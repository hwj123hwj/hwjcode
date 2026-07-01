/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Covers the desktop mirror of the CLI's `modelOverrides` read/write against the
 * shared `~/.easycode-user/settings.json`. fs + os are mocked with an in-memory
 * store so the test never touches the real disk or the user's home directory.
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

import { getUserSettings, updateUserSettings } from './userSettings.js';

// Build with path.join so the key matches the implementation byte-for-byte on
// any OS separator (Windows uses '\\', POSIX uses '/').
const SETTINGS_PATH = path.join('/home/tester', '.easycode-user', 'settings.json');

function seed(json: Record<string, unknown>): void {
  store[SETTINGS_PATH] = JSON.stringify(json);
}

describe('desktop userSettings — modelOverrides mirror', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  it('projects valid modelOverrides from the shared settings file', () => {
    seed({
      modelOverrides: { compression: 'gemini-2.5-pro', codeExpert: 'auto' },
    });
    expect(getUserSettings().modelOverrides).toEqual({
      compression: 'gemini-2.5-pro',
      codeExpert: 'auto',
    });
  });

  it('omits modelOverrides entirely when no valid fields are present', () => {
    seed({ modelOverrides: { compression: '', bogus: 1 } });
    expect(getUserSettings().modelOverrides).toBeUndefined();
  });

  it('writes modelOverrides while preserving unrelated keys', () => {
    seed({ theme: 'dark', preferredLanguage: '中文' });
    updateUserSettings({
      modelOverrides: { verification: 'gemini-2.5-flash' },
    });
    const raw = JSON.parse(store[SETTINGS_PATH]);
    expect(raw.theme).toBe('dark');
    expect(raw.preferredLanguage).toBe('中文');
    expect(raw.modelOverrides).toEqual({ verification: 'gemini-2.5-flash' });
  });

  it('clears the modelOverrides key when patched with an empty object', () => {
    seed({ modelOverrides: { compression: 'gemini-2.5-pro' } });
    updateUserSettings({ modelOverrides: {} });
    const raw = JSON.parse(store[SETTINGS_PATH]);
    expect('modelOverrides' in raw).toBe(false);
  });

  it('strips blank/invalid override fields on write', () => {
    updateUserSettings({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelOverrides: { compression: '  ', codeExpert: 'claude-sonnet-4' } as any,
    });
    const raw = JSON.parse(store[SETTINGS_PATH]);
    expect(raw.modelOverrides).toEqual({ codeExpert: 'claude-sonnet-4' });
  });
});
