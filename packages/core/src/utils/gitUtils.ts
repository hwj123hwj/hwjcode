/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Checks if a directory is within a git repository
 * @param directory The directory to check
 * @returns true if the directory is in a git repository, false otherwise
 */
export function isGitRepository(directory: string): boolean {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      // Check if .git exists (either as directory or file for worktrees)
      if (fs.existsSync(gitDir)) {
        return true;
      }

      const parentDir = path.dirname(currentDir);

      // If we've reached the root directory, stop searching
      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return false;
  } catch (_error) {
    // If any filesystem error occurs, assume not a git repo
    return false;
  }
}

/**
 * Finds the root directory of a git repository
 * @param directory Starting directory to search from
 * @returns The git repository root path, or null if not in a git repository
 */
export function findGitRoot(directory: string): string | null {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      if (fs.existsSync(gitDir)) {
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);

      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return null;
  } catch (_error) {
    return null;
  }
}

/**
 * Gets all remote names and their URLs for the git repository.
 * Strips embedded credentials (userinfo) from URLs for safety.
 * @param directory The directory within the git repository
 * @returns A record of remote name → sanitized URL, or null if unavailable
 */
export function getGitRemotes(directory: string): Record<string, string> | null {
  try {
    const output = execSync('git remote -v', {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!output) return null;

    const remotes: Record<string, string> = {};
    for (const line of output.split('\n')) {
      // Format: "origin\thttps://github.com/org/repo.git (fetch)"
      const match = line.match(/^(\S+)\t(\S+)\s+\(fetch\)$/);
      if (match) {
        remotes[match[1]] = sanitizeGitUrl(match[2]);
      }
    }
    return Object.keys(remotes).length > 0 ? remotes : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Gets the current branch name of the git repository.
 * Returns the short commit hash if in detached HEAD state.
 * @param directory The directory within the git repository
 * @returns The branch name or short hash, or null if unavailable
 */
export function getGitBranch(directory: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (branch && branch !== 'HEAD') return branch;
    // Detached HEAD — fall back to short hash
    return execSync('git rev-parse --short HEAD', {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch (_error) {
    return null;
  }
}

/**
 * Removes embedded credentials from a git URL.
 * e.g. https://user:token@github.com/org/repo.git → https://github.com/org/repo.git
 * SSH URLs (git@...) are returned as-is since they don't embed passwords.
 */
function sanitizeGitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Not a standard URL (e.g. git@github.com:org/repo.git) — safe as-is
    return url;
  }
}
