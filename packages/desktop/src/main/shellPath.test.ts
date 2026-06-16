/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  mergePaths,
  parseShellPath,
  ensurePathFromLoginShell,
  PATH_MARKER,
} from './shellPath.js';

describe('mergePaths', () => {
  it('appends extra dirs not already present, preserving base order', () => {
    const out = mergePaths('/usr/bin:/bin', '/opt/homebrew/bin:/usr/local/bin', ':');
    expect(out).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
  });

  it('dedupes dirs already present in base', () => {
    const out = mergePaths('/usr/bin:/bin', '/usr/local/bin:/bin', ':');
    expect(out).toBe('/usr/bin:/bin:/usr/local/bin');
  });

  it('drops empty segments from both base and extra', () => {
    const out = mergePaths('/usr/bin::', ':/usr/local/bin:', ':');
    expect(out).toBe('/usr/bin:/usr/local/bin');
  });

  it('returns base unchanged when extra is empty', () => {
    expect(mergePaths('/usr/bin:/bin', '', ':')).toBe('/usr/bin:/bin');
  });

  it('returns extra (deduped) when base is empty', () => {
    expect(mergePaths('', '/usr/local/bin:/usr/local/bin', ':')).toBe('/usr/local/bin');
  });

  it('uses the provided separator (Windows semicolon)', () => {
    const out = mergePaths('C:\\Windows', 'C:\\tools;C:\\Windows', ';');
    expect(out).toBe('C:\\Windows;C:\\tools');
  });
});

describe('parseShellPath', () => {
  it('extracts the PATH line wrapped by the marker', () => {
    const stdout = `some noise\n${PATH_MARKER}/usr/local/bin:/usr/bin${PATH_MARKER}\ntrailing`;
    expect(parseShellPath(stdout, PATH_MARKER)).toBe('/usr/local/bin:/usr/bin');
  });

  it('returns null when marker is absent', () => {
    expect(parseShellPath('no marker here', PATH_MARKER)).toBeNull();
  });

  it('returns null when the wrapped value is empty', () => {
    expect(parseShellPath(`${PATH_MARKER}${PATH_MARKER}`, PATH_MARKER)).toBeNull();
  });

  it('trims surrounding whitespace/newlines inside the markers', () => {
    const stdout = `${PATH_MARKER}\n  /usr/local/bin \n${PATH_MARKER}`;
    expect(parseShellPath(stdout, PATH_MARKER)).toBe('/usr/local/bin');
  });
});

describe('ensurePathFromLoginShell', () => {
  const baseEnv = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });

  it('is a no-op on win32 and never spawns a shell', () => {
    const env = baseEnv();
    let called = false;
    const changed = ensurePathFromLoginShell({
      platform: 'win32',
      env,
      runLoginShell: () => {
        called = true;
        return null;
      },
    });
    expect(changed).toBe(false);
    expect(called).toBe(false);
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('merges the login-shell PATH into process env on darwin', () => {
    const env = baseEnv();
    const changed = ensurePathFromLoginShell({
      platform: 'darwin',
      env,
      runLoginShell: () =>
        `${PATH_MARKER}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin${PATH_MARKER}`,
    });
    expect(changed).toBe(true);
    expect(env.PATH).toContain('/usr/local/bin');
    expect(env.PATH).toContain('/opt/homebrew/bin');
    // original dirs preserved up front
    expect(env.PATH.startsWith('/usr/bin:/bin:/usr/sbin:/sbin')).toBe(true);
  });

  it('returns false and leaves PATH untouched when shell lookup fails', () => {
    const env = baseEnv();
    const changed = ensurePathFromLoginShell({
      platform: 'darwin',
      env,
      runLoginShell: () => null,
    });
    expect(changed).toBe(false);
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('returns false when the login PATH adds nothing new', () => {
    const env = { PATH: '/usr/bin:/bin' };
    const changed = ensurePathFromLoginShell({
      platform: 'darwin',
      env,
      runLoginShell: () => `${PATH_MARKER}/usr/bin:/bin${PATH_MARKER}`,
    });
    expect(changed).toBe(false);
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('handles an undefined starting PATH (adopts the shell PATH)', () => {
    const env: { PATH?: string } = {};
    const changed = ensurePathFromLoginShell({
      platform: 'linux',
      env,
      runLoginShell: () => `${PATH_MARKER}/usr/local/bin:/usr/bin${PATH_MARKER}`,
    });
    expect(changed).toBe(true);
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
  });
});
