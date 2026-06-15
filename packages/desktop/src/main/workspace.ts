/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workspace helpers the renderer needs but cannot do itself (no Node access):
 * folder picking, file/dir reads, and git diff for the diff pane + `+N -M` chip.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { dialog, shell, BrowserWindow } from 'electron';
import type { DirEntry, FileBase64, GitFileDiff, PickedFile } from '../shared/ipc.js';

const exec = promisify(execFile);

export async function pickFolder(parent?: BrowserWindow): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(parent!, {
    title: '选择项目目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return undefined;
  return result.filePaths[0];
}

/** Open the native file picker (multi-select) for prompt attachments. */
export async function pickFiles(parent?: BrowserWindow): Promise<PickedFile[]> {
  const result = await dialog.showOpenDialog(parent!, {
    title: '选择附件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
}

/** Map a file extension to an image mime type (only image types are inlined). */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

/**
 * Read a file as base64 + detected mime type. Returns null for non-image files
 * (those should be attached as @-path references, not inlined). Caps at ~20 MB
 * to avoid blowing up the ACP payload / the model's image budget.
 */
export async function readFileBase64(file: string): Promise<FileBase64 | null> {
  const mimeType = IMAGE_MIME[path.extname(file).toLowerCase()];
  if (!mimeType) return null;
  const buf = await fs.readFile(file);
  if (buf.length > 20 * 1024 * 1024) {
    throw new Error('图片过大（>20MB），请压缩后再试。');
  }
  return { mimeType, data: buf.toString('base64') };
}

export async function readFile(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

export async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.claude' || e.name === '.easycode')
    .map((e) => ({
      name: e.name,
      path: path.join(dir, e.name),
      isDir: e.isDirectory(),
    }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

export async function openExternal(url: string): Promise<void> {
  await shell.openExternal(url);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

function classify(numstatStatus: string): GitFileDiff['status'] {
  if (numstatStatus.startsWith('A')) return 'added';
  if (numstatStatus.startsWith('D')) return 'deleted';
  if (numstatStatus.startsWith('R')) return 'renamed';
  return 'modified';
}

/**
 * Collect uncommitted changes (working tree vs HEAD) as a list of per-file
 * diffs with line stats. Tracked changes come from `git diff HEAD`; untracked
 * files are listed separately and shown as fully-added.
 */
export async function gitDiff(cwd: string): Promise<GitFileDiff[]> {
  const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') return [];

  const out: GitFileDiff[] = [];

  // Tracked changes.
  const numstat = await git(cwd, ['diff', 'HEAD', '--numstat']);
  const statusOut = await git(cwd, ['diff', 'HEAD', '--name-status']);
  const statusMap = new Map<string, string>();
  for (const line of statusOut.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 2) statusMap.set(parts[parts.length - 1], parts[0]);
  }
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [addedStr, removedStr, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file) continue;
    const patch = await git(cwd, ['diff', 'HEAD', '--', file]);
    out.push({
      path: file,
      status: classify(statusMap.get(file) ?? 'M'),
      added: Number(addedStr) || 0,
      removed: Number(removedStr) || 0,
      patch,
    });
  }

  // Untracked files.
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  for (const file of untracked.split('\n')) {
    if (!file.trim()) continue;
    let content = '';
    try {
      content = await fs.readFile(path.join(cwd, file), 'utf8');
    } catch {
      continue; // binary or unreadable
    }
    const lines = content.split('\n');
    const patch =
      `--- /dev/null\n+++ b/${file}\n` + lines.map((l) => `+${l}`).join('\n');
    out.push({ path: file, status: 'untracked', added: lines.length, removed: 0, patch });
  }

  return out;
}

export function diffTotals(diffs: GitFileDiff[]): { added: number; removed: number } {
  return diffs.reduce(
    (acc, d) => ({ added: acc.added + d.added, removed: acc.removed + d.removed }),
    { added: 0, removed: 0 },
  );
}
