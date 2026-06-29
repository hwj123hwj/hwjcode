/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

// appInfo.ts statically imports `electron` (and backendLocator, which also
// imports it). Mock it so importing the module under test stays hermetic — the
// `nearestPackageVersion` tests below never touch Electron or the real disk.
vi.mock('electron', () => ({ app: { getVersion: () => '1.1.40' } }));

import { nearestPackageVersion, type FsLike } from './appInfo.js';

/**
 * In-memory {@link FsLike}. Keys are built with `path.join` (the same call the
 * implementation uses), so lookups match byte-for-byte on any OS separator.
 */
function makeFs(files: Record<string, string>): FsLike {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

describe('nearestPackageVersion', () => {
  it('reads the version from a package.json sibling to the entry (bundle case)', () => {
    const entry = path.join('/app', 'bundle', 'easycode.js');
    const fs = makeFs({
      [path.join('/app', 'bundle', 'package.json')]: JSON.stringify({
        name: 'easycode-cli',
        version: '1.1.38',
      }),
    });
    expect(nearestPackageVersion(entry, fs)).toBe('1.1.38');
  });

  it('walks up to the nearest package.json (cli/dist/index.js → cli/package.json)', () => {
    const entry = path.join('/repo', 'packages', 'cli', 'dist', 'index.js');
    const fs = makeFs({
      [path.join('/repo', 'packages', 'cli', 'package.json')]: JSON.stringify({
        version: '1.1.38',
      }),
    });
    expect(nearestPackageVersion(entry, fs)).toBe('1.1.38');
  });

  it('skips a version-less package.json and keeps climbing', () => {
    const entry = path.join('/a', 'b', 'c', 'entry.js');
    const fs = makeFs({
      // Nearest one only declares the module type (no version) — must be skipped.
      [path.join('/a', 'b', 'c', 'package.json')]: JSON.stringify({ type: 'module' }),
      [path.join('/a', 'package.json')]: JSON.stringify({ version: '9.9.9' }),
    });
    expect(nearestPackageVersion(entry, fs)).toBe('9.9.9');
  });

  it('skips a malformed package.json and keeps climbing', () => {
    const entry = path.join('/x', 'y', 'entry.js');
    const fs = makeFs({
      [path.join('/x', 'y', 'package.json')]: '{ not valid json',
      [path.join('/x', 'package.json')]: JSON.stringify({ version: '2.0.0' }),
    });
    expect(nearestPackageVersion(entry, fs)).toBe('2.0.0');
  });

  it('returns undefined when no versioned package.json exists', () => {
    const entry = path.join('/no', 'pkg', 'here.js');
    expect(nearestPackageVersion(entry, makeFs({}))).toBeUndefined();
  });

  it('does not look past maxLevels', () => {
    const entry = path.join('/a', 'b', 'c', 'd', 'entry.js');
    const fs = makeFs({
      // Three levels up — out of reach when maxLevels is 2.
      [path.join('/a', 'package.json')]: JSON.stringify({ version: '1.0.0' }),
    });
    expect(nearestPackageVersion(entry, fs, 2)).toBeUndefined();
  });
});
