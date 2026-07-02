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

/** Helper: build a mock npm registry response. */
function mockNpmResponse(version: string) {
  return {
    ok: true,
    json: async () => ({ version }),
  };
}

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.DEV;
    delete process.env.CLI_VERSION;
    // Mock successful package.json — default: same name as the real fork
    getPackageJson.mockResolvedValue({
      name: 'hwjcode',
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

  it('should return null if npm latest equals current version (no update)', async () => {
    // package.json version is 1.0.0, npm latest is also 1.0.0
    mockFetch.mockResolvedValue(mockNpmResponse('1.0.0'));

    const result = await checkForUpdates(false, true);
    expect(result).toBeNull();
  });

  it('should return a FORCE_UPDATE message when npm has a newer version', async () => {
    // package.json version is 1.0.0, npm latest is 1.1.0
    mockFetch.mockResolvedValue(mockNpmResponse('1.1.0'));

    const result = await checkForUpdates(true, true);
    expect(result).not.toBeNull();
    // Fork: all updates are force updates
    expect(result).toContain('FORCE_UPDATE:1.1.0');
    expect(result).toContain('1.0.0');
    expect(result).toContain('1.1.0');
    // updateCommand should use the real package name
    expect(result).toContain('npm install -g hwjcode@latest');
  });

  it('should return FORCE_UPDATE even when showProgress is false (fork forces all updates)', async () => {
    mockFetch.mockResolvedValue(mockNpmResponse('1.1.0'));

    const result = await checkForUpdates(false, true);
    // Fork: force update = true regardless of showProgress
    expect(result).not.toBeNull();
    expect(result).toContain('FORCE_UPDATE:1.1.0');
  });

  it('should return null when npm latest equals current version', async () => {
    mockFetch.mockResolvedValue(mockNpmResponse('1.0.0'));

    const result = await checkForUpdates(true, true);
    expect(result).toBeNull();
  });

  it('should return null when npm latest is older than current version', async () => {
    mockFetch.mockResolvedValue(mockNpmResponse('0.9.9'));

    const result = await checkForUpdates(true, true);
    expect(result).toBeNull();
  });

  it('should still notify update when version strings are non-semver', async () => {
    getPackageJson.mockResolvedValue({
      name: 'hwjcode',
      version: 'not-a-semver',
    });
    mockFetch.mockResolvedValue(mockNpmResponse('also-not-semver'));

    const result = await checkForUpdates(true, true);
    expect(result).toContain('FORCE_UPDATE:');
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

  it('should return null gracefully when npm returns non-JSON (e.g. HTML error page)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>',
    });
    // json() will throw — should be caught
    const result = await checkForUpdates(true, true);
    expect(result).toBeNull();
  });

  it('should send a user-agent derived from the package name and version', async () => {
    mockFetch.mockResolvedValue(mockNpmResponse('1.0.0'));

    await checkForUpdates(false, true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['User-Agent']).toBe('hwjcode/1.0.0');
  });

  it('should use the CI-injected CLI_VERSION instead of the stale package.json version', async () => {
    getPackageJson.mockResolvedValue({
      name: 'hwjcode',
      version: '1.1.14',
    });
    process.env.CLI_VERSION = '1.1.36';

    mockFetch.mockResolvedValue(mockNpmResponse('1.1.36'));

    const result = await checkForUpdates(true, true);

    // npm registry URL must be used (not company backend)
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('registry.npmjs.org');
    expect(init.headers['User-Agent']).toBe('hwjcode/1.1.36');

    // 1.1.36 npm latest is not newer than 1.1.36 install → no prompt.
    expect(result).toBeNull();
  });

  it('should still detect a genuine update relative to the injected CLI_VERSION', async () => {
    getPackageJson.mockResolvedValue({
      name: 'hwjcode',
      version: '1.1.14',
    });
    process.env.CLI_VERSION = '1.1.36';

    mockFetch.mockResolvedValue(mockNpmResponse('1.1.40'));

    const result = await checkForUpdates(true, true);

    expect(result).toContain('FORCE_UPDATE:1.1.40');
    expect(result).toContain('1.1.36');
    expect(result).not.toContain('1.1.14');
  });

  it('should query the npm registry (not company backend api-code.deepvlab.ai)', async () => {
    mockFetch.mockResolvedValue(mockNpmResponse('1.0.0'));

    await checkForUpdates(false, true);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('registry.npmjs.org');
    expect(url).not.toContain('api-code.deepvlab.ai');
  });
});
