/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Syntax highlighting for the file viewer and Markdown code fences. Uses
 * highlight.js' "common" bundle (~40 mainstream languages, synchronous, no
 * wasm) and emits HTML with `hljs-*` token classes; the colours are mapped to
 * the app's theme CSS vars in index.css so highlighting follows light/dark.
 */

import hljs from 'highlight.js/lib/common';

/** File extension → highlight.js language id. Only ids in the common bundle
 *  (plus aliases hljs already knows) resolve; unknown ones fall back to auto. */
const EXT_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json',
  py: 'python', pyw: 'python',
  rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', lua: 'lua', pl: 'perl', r: 'r', sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
  diff: 'diff', patch: 'diff', dockerfile: 'dockerfile', makefile: 'makefile',
  graphql: 'graphql', gql: 'graphql',
};

/** Resolve a registered highlight.js language for a filename, or undefined. */
export function languageForFile(name: string): string | undefined {
  const base = name.toLowerCase();
  // Extension-less, well-known filenames.
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1);
  const lang = EXT_LANG[ext] ?? ext;
  return hljs.getLanguage(lang) ? lang : undefined;
}

/** Escape text for safe injection when we don't highlight (plain fallback). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Highlight `code`, returning HTML for `<code>`'s innerHTML and the resolved
 * language. `hint` may be a filename (viewer) or a fence language (markdown).
 * Falls back to auto-detection, then to escaped plain text — never throws.
 */
export function highlightCode(code: string, hint: string): { html: string; language: string } {
  try {
    // A fence hint like "ts" or a filename like "foo.ts".
    const lang = hint.includes('.') || !hljs.getLanguage(hint) ? languageForFile(hint) : hint;
    if (lang) {
      const res = hljs.highlight(code, { language: lang, ignoreIllegals: true });
      return { html: res.value, language: lang };
    }
    // Unknown language: auto-detect over the common set (bounded — fast enough
    // for a single viewed file / fence).
    const auto = hljs.highlightAuto(code);
    return { html: auto.value, language: auto.language ?? 'plaintext' };
  } catch {
    return { html: escapeHtml(code), language: 'plaintext' };
  }
}
