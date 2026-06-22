/**
 * Defensive preprocessing for LLM-emitted markdown text.
 *
 * Real-world LLM outputs (observed in user bug reports) sometimes glue the
 * opening fence, the language tag, the body, and the closing fence onto a
 * single line — e.g. ```bashopen ios/Runner.xcworkspace```. Per CommonMark
 * spec, an opening fence must end the line, so react-markdown treats this
 * pattern as inline code, losing the language hint, the syntax-highlighting
 * affordance, and the copy button.
 *
 * `rehabGluedSingleLineFences` rewrites such single-line fences into proper
 * multi-line block fences:
 *
 *     ```bashopen ios/foo```
 * becomes
 *     ```bash
 *     open ios/foo
 *     ```
 *
 * It also handles bogus glued language tags by:
 *   1. Trying to split a known-language prefix from the captured token
 *      (`bashopen` → `bash` + `open`).
 *   2. Falling back to no language and treating the whole token as body.
 */

// Known language identifiers (lowercase). Mirror the CLI-side allowlist.
// Includes lowlight's `common` set plus popular aliases LLMs frequently emit.
const KNOWN_FENCE_LANGS = new Set<string>([
  // lowlight "common" set
  'arduino', 'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'graphql',
  'ini', 'java', 'javascript', 'json', 'kotlin', 'less', 'lua', 'makefile',
  'markdown', 'objectivec', 'perl', 'php', 'php-template', 'plaintext',
  'python', 'python-repl', 'r', 'ruby', 'rust', 'scss', 'shell', 'sql',
  'swift', 'typescript', 'vbnet', 'wasm', 'xml', 'yaml',
  // Common aliases / extensions
  'js', 'jsx', 'ts', 'tsx', 'sh', 'zsh', 'fish', 'powershell', 'ps1', 'pwsh',
  'bat', 'cmd', 'cs', 'fs', 'fsharp', 'kt', 'kts', 'rb', 'py', 'rs', 'dart',
  'flutter', 'dockerfile', 'docker', 'toml', 'csv', 'tsv', 'log', 'md', 'mdx',
  'html', 'htm', 'svg', 'vue', 'svelte', 'astro', 'tex', 'latex', 'bibtex',
  'asm', 'nasm', 'gas', 'vim', 'viml', 'lisp', 'clojure', 'clj', 'cljs',
  'elixir', 'ex', 'exs', 'erlang', 'erl', 'haskell', 'hs', 'ocaml', 'ml',
  'scala', 'groovy', 'gradle', 'cmake', 'mermaid', 'plantuml', 'graphviz',
  'dot', 'protobuf', 'proto', 'thrift', 'capnp', 'nginx', 'apache', 'caddy',
  'env', 'conf', 'config', 'properties', 'gitignore', 'gitconfig',
  // Generic/text-y
  'text', 'plain', 'plaintext', 'txt', 'console', 'output', 'terminal',
  'c++', 'c#', 'obj-c', 'objective-c',
]);

const KNOWN_FENCE_LANGS_BY_LEN = [...KNOWN_FENCE_LANGS].sort(
  (a, b) => b.length - a.length,
);

function splitGluedLang(token: string): { lang: string; leftover: string } | null {
  if (!token) return null;
  const lower = token.toLowerCase();
  for (const known of KNOWN_FENCE_LANGS_BY_LEN) {
    if (lower.startsWith(known) && lower.length > known.length) {
      return {
        lang: token.slice(0, known.length),
        leftover: token.slice(known.length),
      };
    }
  }
  return null;
}

/**
 * Match a single-line glued fence: ```<lang?><body>``` (no internal newline).
 * The lang/body split mirrors the CLI parser:
 *   - lang is `[A-Za-z0-9_+#-]*` (excludes '.' and '/' so paths fall into body)
 *   - body is everything between lang and the closing fence
 *
 * Captures:
 *   1: opening fence run (``` or ~~~ or longer)
 *   2: lang token (may be empty)
 *   3: body (may include leading whitespace)
 *   4: closing fence run
 */
const GLUED_FENCE_RE =
  /(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#-]*)[ \t]*([^\n`~]*?)[ \t]*(`{3,}|~{3,})/g;

export function rehabGluedSingleLineFences(text: string): string {
  if (!text || (!text.includes('```') && !text.includes('~~~'))) return text;

  return text.replace(
    GLUED_FENCE_RE,
    (whole, openFence: string, rawLang: string, rawBody: string, closeFence: string) => {
      // Sanity check: same fence char family, closer at least as long.
      if (openFence[0] !== closeFence[0]) return whole;
      if (closeFence.length < openFence.length) return whole;

      let lang = rawLang || '';
      let body = rawBody || '';

      // Resolve glued bogus language tag.
      if (lang) {
        const normalized = lang.toLowerCase();
        if (!KNOWN_FENCE_LANGS.has(normalized)) {
          const split = splitGluedLang(lang);
          if (split) {
            // bashopen → bash + open
            const needsSpace = body.length > 0 && !/^[\s/.]/.test(body);
            body = body.length > 0
              ? `${split.leftover}${needsSpace ? ' ' : ''}${body}`
              : split.leftover;
            lang = split.lang;
          } else {
            // Unknown token → push to body, drop lang.
            const needsSpace = body.length > 0 && !/^[\s/.]/.test(body);
            body = body.length > 0
              ? `${lang}${needsSpace ? ' ' : ''}${body}`
              : lang;
            lang = '';
          }
        }
      }

      // If body is genuinely empty, leave the original text alone — the empty
      // block heuristic in `CodeBlock` will hide it gracefully.
      if (!body.trim()) return whole;

      // Promote to multi-line block fence. Keep the original opening fence
      // length to preserve nesting semantics. Surround with newlines so this
      // is parsed as a block by remark.
      return `\n${openFence}${lang}\n${body}\n${closeFence}\n`;
    },
  );
}

/**
 * Escape raw `<` characters in markdown text that are NOT inside code blocks
 * or inline code spans.
 *
 * Why: `rehypeRaw` treats raw `<tag>` in markdown as HTML and strips/hides
 * unknown tags. When an LLM writes prose like "key: `xunxiashi:...:​<sessionScope>`"
 * or "use <T> as a type parameter", the `<sessionScope>` / `<T>` fragment is
 * silently swallowed, making part of the answer invisible — the user sees an
 * empty gap.
 *
 * By escaping only the `<` that appear in normal prose (never inside fenced or
 * inline code), we let `rehypeRaw` render legitimate HTML while preventing
 * pseudo-HTML angle brackets from eating content.
 *
 * `>` is left untouched so that markdown blockquotes (`> quote`) still work.
 */
export function escapeRawHtmlAngles(text: string): string {
  if (!text || !text.includes('<')) return text;

  // Split on fenced code blocks (```...```) and inline code spans (`...`),
  // only transforming the non-code segments.
  //
  // We use a single regex that matches either a fenced block or an inline code
  // span, and replace `<` → `&lt;` only in the text between them.
  const parts: string[] = [];
  let lastIndex = 0;

  // Matches fenced code blocks (``` or ~~~, multi-line) or inline code spans
  // (single backtick pairs on the same line).
  const codeTokenRe =
    /(`{3,}|~{3,})[\s\S]*?\1|(`+)(?:[^`]|(?!\2).)*?\2/g;
  let m: RegExpExecArray | null;

  while ((m = codeTokenRe.exec(text)) !== null) {
    // Escape `<` in the prose text before this code token.
    if (m.index > lastIndex) {
      parts.push(text.slice(lastIndex, m.index).replace(/</g, '&lt;'));
    }
    // Push the code token verbatim — do NOT escape inside code.
    parts.push(m[0]);
    lastIndex = m.index + m[0].length;
  }

  // Escape `<` in the remaining trailing prose.
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex).replace(/</g, '&lt;'));
  }

  return parts.join('');
}
