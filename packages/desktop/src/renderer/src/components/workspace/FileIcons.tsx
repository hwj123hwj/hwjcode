/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Colourful, VSCode-style file/folder icons for the explorer tree and tab bar.
 *
 * Rather than pull in the full `material-icon-theme` package (hundreds of SVGs,
 * 1MB+) we ship a curated, self-contained set in the same visual language: a
 * tinted "document" badge carrying the type's brand colour + a short monogram
 * for source/text files, plus a handful of dedicated full-colour glyphs (folder,
 * image, archive, lock, license, gear/config). This covers every common type the
 * file browser shows while adding ZERO new dependencies and a negligible bundle
 * cost (a few KB of inline SVG strings). Add a type by extending `BY_EXT` /
 * `BY_NAME` below.
 */

/** A document "badge": a tinted sheet + folded corner + a coloured monogram. */
function badge(color: string, label: string): string {
  const len = label.length;
  const fs = len <= 2 ? 7 : len === 3 ? 6 : 5;
  return (
    `<path d="M6 2h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="${color}" fill-opacity="0.16"/>` +
    `<path d="M13 2l5 5h-4a1 1 0 0 1-1-1z" fill="${color}" fill-opacity="0.45"/>` +
    `<text x="11.5" y="17" text-anchor="middle" font-size="${fs}" font-weight="700" ` +
    `fill="${color}" font-family="ui-monospace, Menlo, Consolas, monospace">${label}</text>`
  );
}

/** Self-coloured glyphs (no document outline) for non-text file kinds + folders. */
const GLYPHS = {
  folder:
    '<path d="M3.2 6.5A1.5 1.5 0 0 1 4.7 5h3.9a1.5 1.5 0 0 1 1.06.44L11 6.8a1.5 1.5 0 0 0 1.06.44h7.24A1.5 1.5 0 0 1 20.8 8.7v8.8A1.5 1.5 0 0 1 19.3 19H4.7a1.5 1.5 0 0 1-1.5-1.5z" fill="#e2a03f"/>',
  'folder-open':
    '<path d="M3.2 6.5A1.5 1.5 0 0 1 4.7 5h3.9a1.5 1.5 0 0 1 1.06.44L11 6.8a1.5 1.5 0 0 0 1.06.44h7.24A1.5 1.5 0 0 1 20.8 8.7V10.5H6.6a1.5 1.5 0 0 0-1.45 1.1L3.2 18z" fill="#c98a2f"/>' +
    '<path d="M5.1 11.6A1.5 1.5 0 0 1 6.55 10.5H20.8a1 1 0 0 1 .96 1.27l-1.66 6A1.5 1.5 0 0 1 18.65 19H3.5z" fill="#f0bd6a"/>',
  image:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.2" fill="#26a69a"/>' +
    '<circle cx="8.4" cy="9.4" r="1.8" fill="#ffffff" fill-opacity="0.92"/>' +
    '<path d="M4.5 18l4.3-4.7 3 3 3.4-3.9L19.5 18z" fill="#ffffff" fill-opacity="0.92"/>',
  archive:
    '<rect x="4.5" y="3.5" width="15" height="17" rx="2" fill="#b9805a"/>' +
    '<rect x="10.6" y="3.5" width="2.8" height="17" fill="#d8a880"/>' +
    '<rect x="10.6" y="7.5" width="2.8" height="2.4" fill="#7a4a2c"/>' +
    '<rect x="10.6" y="12" width="2.8" height="2.4" fill="#7a4a2c"/>',
  lock:
    '<rect x="5" y="10.5" width="14" height="10" rx="1.8" fill="#9aa0a6"/>' +
    '<path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="#9aa0a6" stroke-width="2"/>' +
    '<circle cx="12" cy="15" r="1.6" fill="#5f6368"/>',
  license:
    '<circle cx="12" cy="9" r="5.4" fill="#e6b93f"/>' +
    '<path d="M9 13.4l-1.5 6.3L12 17l4.5 2.7L15 13.4z" fill="#caa02f"/>' +
    '<circle cx="12" cy="9" r="2.5" fill="#ffffff" fill-opacity="0.85"/>',
  config:
    '<g fill="#7e8a99"><circle cx="12" cy="12" r="3.1"/>' +
    '<rect x="11" y="2.6" width="2" height="4.2" rx="1"/><rect x="11" y="17.2" width="2" height="4.2" rx="1"/>' +
    '<rect x="2.6" y="11" width="4.2" height="2" rx="1"/><rect x="17.2" y="11" width="4.2" height="2" rx="1"/>' +
    '<rect x="5" y="5.2" width="2" height="4.2" rx="1" transform="rotate(45 6 7.3)"/>' +
    '<rect x="17" y="14.6" width="2" height="4.2" rx="1" transform="rotate(45 18 16.7)"/>' +
    '<rect x="17" y="5.2" width="2" height="4.2" rx="1" transform="rotate(-45 18 7.3)"/>' +
    '<rect x="5" y="14.6" width="2" height="4.2" rx="1" transform="rotate(-45 6 16.7)"/></g>',
} as const;

type GlyphName = keyof typeof GLYPHS;

/** Badge colour/label per extension (no leading dot). */
const BY_EXT: Record<string, { color: string; label: string } | GlyphName> = {
  // web / scripting
  js: { color: '#e8d44d', label: 'JS' },
  mjs: { color: '#e8d44d', label: 'JS' },
  cjs: { color: '#e8d44d', label: 'JS' },
  jsx: { color: '#5fcbf0', label: 'JSX' },
  ts: { color: '#4a90d9', label: 'TS' },
  tsx: { color: '#5fcbf0', label: 'TSX' },
  json: { color: '#e8c14d', label: '{}' },
  jsonc: { color: '#e8c14d', label: '{}' },
  vue: { color: '#41b883', label: 'VUE' },
  svelte: { color: '#e0533a', label: 'SV' },
  html: { color: '#e34c26', label: '<>' },
  htm: { color: '#e34c26', label: '<>' },
  css: { color: '#4a90d9', label: 'CSS' },
  scss: { color: '#cd6799', label: 'SAS' },
  sass: { color: '#cd6799', label: 'SAS' },
  less: { color: '#5a83c4', label: 'LES' },
  // languages
  py: { color: '#4b8bbe', label: 'PY' },
  go: { color: '#4dc4df', label: 'GO' },
  rs: { color: '#d08962', label: 'RS' },
  java: { color: '#e76f00', label: 'JV' },
  kt: { color: '#a97bff', label: 'KT' },
  c: { color: '#5d9ad3', label: 'C' },
  h: { color: '#8a9aa8', label: 'H' },
  cpp: { color: '#5d9ad3', label: 'C++' },
  cc: { color: '#5d9ad3', label: 'C++' },
  hpp: { color: '#8a9aa8', label: 'H' },
  cs: { color: '#68217a', label: 'C#' },
  rb: { color: '#cc342d', label: 'RB' },
  php: { color: '#777bb3', label: 'PHP' },
  swift: { color: '#f05138', label: 'SW' },
  sql: { color: '#e38c2f', label: 'SQL' },
  sh: { color: '#4caf50', label: '>_' },
  bash: { color: '#4caf50', label: '>_' },
  zsh: { color: '#4caf50', label: '>_' },
  ps1: { color: '#4a90d9', label: 'PS' },
  // data / config
  yml: { color: '#9bbb59', label: 'YML' },
  yaml: { color: '#9bbb59', label: 'YML' },
  toml: { color: '#9c6f4a', label: 'TOM' },
  xml: { color: '#e9803a', label: '<>' },
  ini: { color: '#8a9aa8', label: 'INI' },
  env: { color: '#e8c14d', label: 'ENV' },
  // docs / text
  md: { color: '#5a9bf0', label: 'MD' },
  markdown: { color: '#5a9bf0', label: 'MD' },
  mdx: { color: '#5a9bf0', label: 'MDX' },
  txt: { color: '#9aa0a6', label: 'TXT' },
  log: { color: '#9aa0a6', label: 'LOG' },
  pdf: { color: '#e2554d', label: 'PDF' },
  csv: { color: '#4caf50', label: 'CSV' },
  // images
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  ico: 'image',
  // archives
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  rar: 'archive',
  '7z': 'archive',
  xz: 'archive',
  // locks
  lock: 'lock',
};

/** Badge/glyph keyed by exact (lowercased) file name — wins over the extension. */
const BY_NAME: Record<string, { color: string; label: string } | GlyphName> = {
  'package.json': { color: '#8bc34a', label: '{}' },
  'package-lock.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'tsconfig.json': 'config',
  'jsconfig.json': 'config',
  '.gitignore': { color: '#f05133', label: 'GIT' },
  '.gitattributes': { color: '#f05133', label: 'GIT' },
  '.npmrc': 'config',
  '.editorconfig': 'config',
  '.prettierrc': 'config',
  'prettier.config.js': 'config',
  '.eslintrc': 'config',
  '.eslintrc.js': 'config',
  '.eslintrc.json': 'config',
  '.eslintrc.cjs': 'config',
  'eslint.config.js': 'config',
  'eslint.config.mjs': 'config',
  'vite.config.ts': 'config',
  'vite.config.js': 'config',
  'webpack.config.js': 'config',
  'rollup.config.js': 'config',
  'babel.config.js': 'config',
  '.babelrc': 'config',
  dockerfile: { color: '#4a90d9', label: 'DK' },
};

const DEFAULT_FILE: { color: string; label: string } = { color: '#9aa0a6', label: '' };

/** Resolve the inner SVG markup for a file/folder name. */
function resolveMarkup(name: string, isDir: boolean, open: boolean): string {
  if (isDir) return GLYPHS[open ? 'folder-open' : 'folder'];

  const lower = name.toLowerCase();
  // LICENSE / COPYING (with or without an extension) → the gold license glyph.
  if (lower.startsWith('license') || lower.startsWith('copying')) return GLYPHS.license;

  const named = BY_NAME[lower];
  const pick = named ?? BY_EXT[lower.slice(lower.lastIndexOf('.') + 1)] ?? DEFAULT_FILE;
  if (typeof pick === 'string') return GLYPHS[pick];
  return badge(pick.color, pick.label);
}

export interface FileIconProps {
  /** File or folder base name (used to pick the icon). */
  name: string;
  /** Render the folder glyph instead of a file badge. */
  isDir?: boolean;
  /** When `isDir`, render the open-folder glyph. */
  open?: boolean;
  /** Pixel size of the (square) icon. Defaults to 16. */
  size?: number;
  className?: string;
}

/** A colourful, VSCode-style icon for a file or folder. */
export function FileIcon({ name, isDir = false, open = false, size = 16, className }: FileIconProps) {
  return (
    <svg
      className={`file-ic${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: resolveMarkup(name, isDir, open) }}
    />
  );
}
