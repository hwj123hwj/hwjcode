/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { checkForUpdates } from './updateCheck.js';

const getPackageJson = vi.hoisted(() => vi.fn());
vi.mock('../../utils/package.js', () => ({
  getPackageJson,
}));

// Mock fs and os properly for Vitest 3
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue('/tmp/home'),
  };
});

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Clear environment variables that affect version resolution before each test
    delete process.env.DEV;
    delete process.env.CLI_VERSION;
    // Mock successful package.json
    getPackageJson.mockResolvedValue({
      name: 'deepv-code-cli',
      version: '1.0.0',
    });
  });

  it('should return null when running from source (DEV=true)', async () => {
    process.env.DEV = 'true';
    const result = await checkForUpdates();
    expect(result).toBeNull();
    expect(getPackageJson).not.toHaveBeenCalled();
  });

  it('should return null if package.json is missing', async () => {
    getPackageJson.mockResolvedValue(null);
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return null if there is no update', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: false,
      }),
    });

    const result = await checkForUpdates(false, true);
    expect(result).toBeNull();
  });

  it('should return a message if a newer version is available and showProgress is true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: true,
        latestVersion: '1.1.0',
        updateCommand: 'npm install -g deepv-code-cli',
      }),
    });

    const result = await checkForUpdates(true, true);
    expect(result).not.toBeNull();
    expect(result).toContain('UPDATE_AVAILABLE:1.1.0');
    expect(result).toContain('1.0.0');
    expect(result).toContain('1.1.0');
  });

  it('should return null if newer version available but showProgress is false and not forced update', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: true,
        latestVersion: '1.1.0',
        updateCommand: 'npm install -g deepv-code-cli',
      }),
    });

    const result = await checkForUpdates(false, true);
    expect(result).toBeNull();
  });

  it('should return null when server reports hasUpdate but latestVersion equals current version', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: true,
        latestVersion: '1.0.0',
        updateCommand: 'npm install -g deepv-code-cli',
      }),
    });

    const result = await checkForUpdates(true, true);
    expect(result).toBeNull();
  });

  it('should return null when server reports hasUpdate but latestVersion is older than current version', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: true,
        latestVersion: '0.9.9',
        updateCommand: 'npm install -g deepv-code-cli',
      }),
    });

    const result = await checkForUpdates(true, true);
    expect(result).toBeNull();
  });

  it('should not force update when latestVersion is not newer than current version', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: true,
        forceUpdate: true,
        latestVersion: '1.0.0',
        updateCommand: 'npm install -g deepv-code-cli',
      }),
    });

    const result = await checkForUpdates(false, true);
    expect(result).toBeNull();
  });

  it('should still notify update when version strings are non-semver (trust server)', async () => {
    getPackageJson.mockResolvedValue({
      name: 'deepv-code-cli',
      version: 'not-a-semver',
    });
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: true,
        latestVersion: 'also-not-semver',
        updateCommand: 'npm install -g deepv-code-cli',
      }),
    });

    const result = await checkForUpdates(true, true);
    expect(result).toContain('UPDATE_AVAILABLE:');
  });

  it('should return a FORCE_UPDATE message if forceUpdate is true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: true,
        forceUpdate: true,
        latestVersion: '1.1.0',
        updateCommand: 'npm install -g deepv-code-cli',
      }),
    });

    const result = await checkForUpdates(false, true);
    expect(result).not.toBeNull();
    expect(result).toContain('FORCE_UPDATE:1.1.0');
  });

  it('should handle fetch errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const result = await checkForUpdates(false, true);
    expect(result).toBeNull();
  });

  it('should handle HTTP error status gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });
    const result = await checkForUpdates(false, true);
    expect(result).toBeNull();
  });

  it('should return null gracefully when the server returns non-JSON (e.g. HTML error page)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>',
    });
    const result = await checkForUpdates(true, true);
    expect(result).toBeNull();
  });

  it('should send a user-agent derived from the package name and version', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, hasUpdate: false }),
    });

    await checkForUpdates(false, true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['User-Agent']).toBe('deepv-code-cli/1.0.0');
  });

  it('should use the CI-injected CLI_VERSION instead of the stale package.json version', async () => {
    // Reproduces the real bug: package.json carries a stale placeholder version
    // (e.g. 1.1.14) while the CI build injects the real version via CLI_VERSION
    // (e.g. 1.1.36). The update check must report the injected version, not the
    // stale one, otherwise the server is queried with a wrong version and keeps
    // offering an "update" to a version the user already runs.
    getPackageJson.mockResolvedValue({
      name: 'easycode',
      version: '1.1.14',
    });
    process.env.CLI_VERSION = '1.1.36';

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: true,
        latestVersion: '1.1.36',
        updateCommand: 'npm install -g easycode-ai',
      }),
    });

    const result = await checkForUpdates(true, true);

    // Server query and user-agent must carry the real injected version.
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('version=1.1.36');
    expect(init.headers['User-Agent']).toBe('easycode/1.1.36');

    // 1.1.36 server-latest is not newer than the real 1.1.36 install → no prompt.
    expect(result).toBeNull();
  });

  it('should still detect a genuine update relative to the injected CLI_VERSION', async () => {
    getPackageJson.mockResolvedValue({
      name: 'easycode',
      version: '1.1.14',
    });
    process.env.CLI_VERSION = '1.1.36';

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        hasUpdate: true,
        latestVersion: '1.1.40',
        updateCommand: 'npm install -g easycode-ai',
      }),
    });

    const result = await checkForUpdates(true, true);

    expect(result).toContain('UPDATE_AVAILABLE:1.1.40');
    expect(result).toContain('1.1.36');
    expect(result).not.toContain('1.1.14');
  });
});