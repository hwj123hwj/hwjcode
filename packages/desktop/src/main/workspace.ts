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
import { clipboard, dialog, shell, BrowserWindow } from 'electron';
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

/** Reverse of IMAGE_MIME — the canonical extension for a known image mime. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

/**
 * Persist an attached/pasted image into `<cwd>/.easycode/clipboard/` with a
 * real extension, returning the absolute path. This mirrors the vscode
 * composer's `ensureImageFilePath`: inlined image bytes are also dropped to a
 * real file so non-multimodal models (and the `image_reader` tool, which keys
 * off the path's extension) can reach the picture. Returns null on failure.
 */
export async function saveClipboardImage(
  cwd: string,
  mimeType: string,
  dataB64: string,
  name?: string,
): Promise<string | null> {
  try {
    if (!dataB64) return null;
    const ext =
      MIME_EXT[mimeType] ||
      (name && path.extname(name).toLowerCase()) ||
      '.png';
    const dir = path.join(cwd, '.easycode', 'clipboard');
    await fs.mkdir(dir, { recursive: true });
    const unique = `easycode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const dest = path.join(dir, unique);
    await fs.writeFile(dest, Buffer.from(dataB64, 'base64'));
    return dest;
  } catch {
    return null;
  }
}

/**
 * Read a bitmap from the OS clipboard as base64 PNG. Electron's main-process
 * clipboard is far more reliable than the renderer's `ClipboardEvent` on
 * Windows, where a "copy image" often exposes no `image/*` DataTransferItem.
 */
/** Write plain text to the OS clipboard (code viewer "Copy" menu item). */
export function writeClipboardText(text: string): void {
  clipboard.writeText(text);
}

export function readClipboardImage(): FileBase64 | null {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    const png = img.toPNG();
    if (!png || png.length === 0) return null;
    return { mimeType: 'image/png', data: png.toString('base64') };
  } catch {
    return null;
  }
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

/**
 * Directory names skipped while walking the tree for the fuzzy file finder —
 * the usual heavy / generated / VCS folders that VSCode's quick-open also hides.
 * Hidden dirs (`.foo`) are skipped too, except the project-relevant ones.
 */
const SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', 'release',
  'coverage', '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache', 'target',
  'vendor', '.venv', 'venv', '__pycache__', '.idea', '.vscode-test', 'bin', 'obj',
]);
const SEARCH_KEEP_HIDDEN = new Set(['.claude', '.easycode', '.github', '.vscode']);
/** Hard cap so a giant repo can't freeze the walk / blow up the renderer list. */
const SEARCH_FILE_CAP = 20000;

/**
 * Recursively collect every file under `root` as a forward-slash relative path,
 * skipping the heavy/generated dirs above. Breadth-ish DFS with a file cap; the
 * renderer ranks the result with fuzzysort, so order here is just stable-ish.
 */
export async function searchFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (files.length >= SEARCH_FILE_CAP) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions / vanished) — skip
    }
    // Files first (cheap), then descend — keeps shallow matches near the top.
    const subdirs: Array<{ abs: string; rel: string }> = [];
    for (const e of entries) {
      if (files.length >= SEARCH_FILE_CAP) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && !SEARCH_KEEP_HIDDEN.has(e.name)) continue;
        subdirs.push({ abs: path.join(dir, e.name), rel: childRel });
      } else if (e.isFile()) {
        files.push(childRel);
      }
    }
    for (const sd of subdirs) await walk(sd.abs, sd.rel);
  };
  await walk(root, '');
  return files;
}

export async function openExternal(url: string): Promise<void> {
  await shell.openExternal(url);
}

/** Reveal a file/folder in the OS file manager (Explorer / Finder / etc.). */
export function revealInFolder(target: string): void {
  shell.showItemInFolder(target);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * The current git branch of `cwd` (or null if it isn't a git work tree).
 * `dirty` is true when there are staged/unstaged/untracked changes — surfaced
 * as a `*` suffix next to the branch name in the prompt bar.
 */
export async function gitBranch(
  cwd: string,
): Promise<{ branch: string; dirty: boolean } | null> {
  const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') return null;

  let branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  // Detached HEAD → fall back to the short commit hash.
  if (!branch || branch === 'HEAD') {
    const short = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
    branch = short ? `(${short})` : '';
  }
  if (!branch) return null;

  const status = await git(cwd, ['status', '--porcelain']);
  return { branch, dirty: status.trim().length > 0 };
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
