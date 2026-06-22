/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Files — a VSCode-style file browser for the right sidebar: a lazy-loading
 * explorer tree, multiple open-file tabs, a path breadcrumb, per-extension
 * icons, Markdown preview, and an "Open in" menu (external IDEs / reveal in
 * folder / open in terminal). Open file tabs live in the global store so they
 * survive sidebar view switches.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import fuzzysort from 'fuzzysort';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { FileIcon } from './FileIcons';
import { Markdown } from '../Markdown';
import { Resizer } from './Resizer';
import { highlightCode } from './codeHighlight';
import { useT, type TFunc } from '../../i18n/useT';
import type { DetectedIde, DirEntry } from '@shared/ipc';

const api = window.easycode;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;

/** The last path segment, tolerating both separators. */
function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Breadcrumb segments of `file` relative to `root` (root's own name first). */
function breadcrumb(root: string, file: string): string[] {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const f = norm(file);
  const rel = f.startsWith(r + '/') ? f.slice(r.length + 1) : baseName(f);
  return [baseName(r), ...rel.split('/').filter(Boolean)];
}

export function FilesPanel() {
  const activeId = useStore((s) => s.activeSessionId);
  const meta = useStore((s) => (activeId ? s.sessions[activeId]?.meta : undefined));
  const tabs = useStore((s) => s.workspace.fileTabs);
  const activeTab = useStore((s) => s.workspace.activeFileTab);
  const openFileTab = useStore((s) => s.openFileTab);
  const closeFileTab = useStore((s) => s.closeFileTab);
  const setActiveFileTab = useStore((s) => s.setActiveFileTab);
  const fileTreeWidth = useStore((s) => s.workspace.fileTreeWidth);
  const setWorkspaceSize = useStore((s) => s.setWorkspaceSize);
  const t = useT();

  // Browse the active session's working folder. Chat sessions use a throwaway
  // internal cwd, so only project sessions get a useful tree.
  const root = meta && meta.kind === 'project' ? meta.cwd : undefined;

  if (!root) {
    return (
      <div className="ws-panel">
        <div className="ws-panel-head">
          <Icon name="folder" size={15} />
          <span>{t('files.title')}</span>
        </div>
        <div className="empty">{t('files.noProject')}</div>
      </div>
    );
  }

  return (
    <div className="ws-panel files-panel">
      <FileTabs
        tabs={tabs}
        activeTab={activeTab}
        onSelect={setActiveFileTab}
        onClose={closeFileTab}
        t={t}
      />
      {/* Viewer on the LEFT, explorer tree on the RIGHT (VSCode-mirrored). */}
      <div className="files-body">
        <div className="files-main">
          {activeTab ? (
            <>
              <FileToolbar root={root} file={activeTab} t={t} />
              <FileContent path={activeTab} t={t} />
            </>
          ) : (
            <div className="empty">{t('files.noOpenTabs')}</div>
          )}
        </div>
        <Resizer
          axis="x"
          getValue={() => useStore.getState().workspace.fileTreeWidth}
          onChange={(v) => setWorkspaceSize('fileTreeWidth', v)}
        />
        <FileTree root={root} activeTab={activeTab} onOpen={openFileTab} width={fileTreeWidth} />
      </div>
    </div>
  );
}

// ── tab bar ──────────────────────────────────────────────────────────────────

function FileTabs({
  tabs,
  activeTab,
  onSelect,
  onClose,
  t,
}: {
  tabs: string[];
  activeTab?: string;
  onSelect: (p: string) => void;
  onClose: (p: string) => void;
  t: TFunc;
}) {
  if (tabs.length === 0) {
    return (
      <div className="file-tabs">
        <span className="file-tabs-empty">
          <Icon name="folder" size={14} />
          {t('files.title')}
        </span>
      </div>
    );
  }
  return (
    <div className="file-tabs">
      {tabs.map((p) => (
        <div
          key={p}
          className={`file-tab ${activeTab === p ? 'active' : ''}`}
          title={p}
          onClick={() => onSelect(p)}
        >
          <FileIcon name={baseName(p)} size={14} />
          <span className="file-tab-name">{baseName(p)}</span>
          <button
            className="file-tab-close"
            title={t('files.closeTab')}
            onClick={(e) => {
              e.stopPropagation();
              onClose(p);
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── breadcrumb + "Open in" toolbar ─────────────────────────────────────────────

function FileToolbar({ root, file, t }: { root: string; file: string; t: TFunc }) {
  const crumbs = useMemo(() => breadcrumb(root, file), [root, file]);
  const [ides, setIdes] = useState<DetectedIde[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void api.ide.detect().then((list) => alive && setIdes(list)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const dir = file.replace(/[\\/][^\\/]*$/, '');

  return (
    <div className="file-toolbar">
      <div className="file-breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i} className="crumb">
            {i > 0 && <Icon name="chevron-right" size={12} />}
            <span className={i === crumbs.length - 1 ? 'crumb-leaf' : ''}>{c}</span>
          </span>
        ))}
      </div>
      <span className="grow" />
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          className="chip interactive file-open-in"
          title={t('files.openIn')}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <Icon name="external-link" size={13} />
          {/* Label + caret collapse away (icon only) when the toolbar is too
              narrow — see the container query in index.css. */}
          <span className="chip-label">{t('files.openIn')}</span>
          <Icon name="chevron-down" size={12} className="chip-caret" />
        </button>
        {menuOpen && (
          <div className="menu-pop" style={{ right: 0, top: '120%' }}>
            {ides.length === 0 && <div className="empty-menu-label">{t('files.noIde')}</div>}
            {ides.map((ide) => (
              <button
                key={ide.id}
                onClick={() => {
                  void api.ide.open(ide.id, file);
                  setMenuOpen(false);
                }}
              >
                <Icon name="code" size={14} />
                {ide.name}
              </button>
            ))}
            <div className="menu-sep" />
            <button
              onClick={() => {
                void api.workspace.revealInFolder(file);
                setMenuOpen(false);
              }}
            >
              <Icon name="folder-open" size={14} />
              {t('files.openInFolder')}
            </button>
            <button
              onClick={() => {
                void api.workspace.openInTerminal(dir);
                setMenuOpen(false);
              }}
            >
              <Icon name="terminal" size={14} />
              {t('files.openInTerminal')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── explorer tree ──────────────────────────────────────────────────────────────

/** Join a forward-slash relative path onto the (possibly Windows) root. */
function joinRoot(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${rel}`;
}

function FileTree({
  root,
  activeTab,
  onOpen,
  width,
}: {
  root: string;
  activeTab?: string;
  onOpen: (p: string) => void;
  width: number;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  // The flat file list backing the fuzzy finder, loaded lazily per root.
  const [files, setFiles] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Build the file index the first time the user searches in this root (and
  // refresh it whenever the root changes).
  useEffect(() => {
    setFiles(null);
    setQuery('');
  }, [root]);

  const searching = query.trim().length > 0;
  useEffect(() => {
    if (!searching || files !== null || loading) return;
    setLoading(true);
    void api.workspace
      .searchFiles(root)
      .then((list) => setFiles(list))
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  }, [searching, files, loading, root]);

  const results = useMemo(() => {
    if (!searching || !files) return [];
    return fuzzysort.go(query.trim(), files, { limit: 80 }).map((r) => r.target);
  }, [query, files, searching]);

  return (
    <div className="file-tree" style={{ width }}>
      <div className="file-tree-head">
        <Icon name="folder" size={13} />
        <span>{t('files.explorer')}</span>
      </div>
      <div className="file-search">
        <Icon name="search" size={13} />
        <input
          className="file-search-input"
          placeholder={t('files.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query && (
          <button className="file-search-clear" title={t('files.searchClear')} onClick={() => setQuery('')}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      <div className="file-tree-body">
        {searching ? (
          loading && !files ? (
            <div className="tree-row tree-loading" style={{ paddingLeft: 10 }}>
              <Icon name="loader" size={13} spin />
            </div>
          ) : results.length === 0 ? (
            <div className="empty file-search-empty">{t('files.searchNoResults')}</div>
          ) : (
            results.map((rel) => {
              const abs = joinRoot(root, rel);
              const slash = rel.lastIndexOf('/');
              const fname = slash < 0 ? rel : rel.slice(slash + 1);
              const dir = slash < 0 ? '' : rel.slice(0, slash);
              return (
                <button
                  key={rel}
                  className={`tree-row search-row ${activeTab === abs ? 'active' : ''}`}
                  style={{ paddingLeft: 10 }}
                  onClick={() => onOpen(abs)}
                  title={rel}
                >
                  <FileIcon name={fname} size={15} />
                  <span className="search-name">{fname}</span>
                  {dir && <span className="search-dir">{dir}</span>}
                </button>
              );
            })
          )
        ) : (
          <TreeNode path={root} name={baseName(root)} isDir depth={0} activeTab={activeTab} onOpen={onOpen} defaultOpen />
        )}
      </div>
    </div>
  );
}

function TreeNode({
  path,
  name,
  isDir,
  depth,
  activeTab,
  onOpen,
  defaultOpen,
}: {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  activeTab?: string;
  onOpen: (p: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isDir || !open || children) return;
    setLoading(true);
    void api.workspace
      .listDir(path)
      .then((entries) => setChildren(entries))
      .catch(() => setChildren([]))
      .finally(() => setLoading(false));
  }, [isDir, open, children, path]);

  const active = !isDir && activeTab === path;
  const indent = 8 + depth * 13;

  if (!isDir) {
    return (
      <button
        className={`tree-row ${active ? 'active' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={() => onOpen(path)}
        title={path}
      >
        <FileIcon name={name} size={15} />
        <span className="tree-name">{name}</span>
      </button>
    );
  }

  return (
    <>
      <button
        className="tree-row"
        style={{ paddingLeft: indent }}
        onClick={() => setOpen((o) => !o)}
        title={path}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        <FileIcon name={name} isDir open={open} size={15} />
        <span className="tree-name">{name}</span>
      </button>
      {open &&
        (loading && !children ? (
          <div className="tree-row tree-loading" style={{ paddingLeft: indent + 19 }}>
            <Icon name="loader" size={13} spin />
          </div>
        ) : (
          (children ?? []).map((c) => (
            <TreeNode
              key={c.path}
              path={c.path}
              name={c.name}
              isDir={c.isDir}
              depth={depth + 1}
              activeTab={activeTab}
              onOpen={onOpen}
            />
          ))
        ))}
    </>
  );
}

// ── content viewer ─────────────────────────────────────────────────────────────

type Loaded =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string }
  | { kind: 'binary' }
  | { kind: 'error' };

function FileContent({ path, t }: { path: string; t: TFunc }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const isMarkdown = MARKDOWN_EXT.test(path);
  const [preview, setPreview] = useState(true);

  useEffect(() => {
    setLoaded(null);
    setPreview(true);
    let alive = true;
    if (IMAGE_EXT.test(path)) {
      void api.workspace
        .readFileBase64(path)
        .then((b64) =>
          alive && setLoaded(b64 ? { kind: 'image', url: `data:${b64.mimeType};base64,${b64.data}` } : { kind: 'binary' }),
        )
        .catch(() => alive && setLoaded({ kind: 'binary' }));
      return () => {
        alive = false;
      };
    }
    void api.workspace
      .readFile(path)
      .then((text) => {
        if (!alive) return;
        // Heuristic binary sniff: a NUL byte means it isn't text.
        setLoaded(text.includes(String.fromCharCode(0)) ? { kind: 'binary' } : { kind: 'text', text });
      })
      .catch(() => alive && setLoaded({ kind: 'error' }));
    return () => {
      alive = false;
    };
  }, [path]);

  if (!loaded) {
    return (
      <div className="file-content">
        <div className="empty">
          <Icon name="loader" size={18} spin />
        </div>
      </div>
    );
  }
  if (loaded.kind === 'error') {
    return (
      <div className="file-content">
        <div className="empty">{t('files.loadFailed')}</div>
      </div>
    );
  }
  if (loaded.kind === 'binary') {
    return (
      <div className="file-content">
        <div className="empty">{t('files.binary')}</div>
      </div>
    );
  }
  if (loaded.kind === 'image') {
    return (
      <div className="file-content">
        <div className="file-image-wrap">
          <img className="file-image" src={loaded.url} alt={baseName(path)} />
        </div>
      </div>
    );
  }

  // text
  return (
    <div className="file-content">
      {isMarkdown && (
        <div className="file-content-toolbar">
          <div className="views-menu">
            <button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>
              {t('files.preview')}
            </button>
            <button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>
              {t('files.source')}
            </button>
          </div>
        </div>
      )}
      {isMarkdown && preview ? (
        <div className="file-md">
          <Markdown text={loaded.text} />
        </div>
      ) : (
        <HighlightedCode text={loaded.text} fileName={baseName(path)} />
      )}
    </div>
  );
}

/** A read-only, syntax-highlighted code view with a line-number gutter and a
 *  right-click menu (Search with Google / Copy / Select All). Highlighting is
 *  memoised per (text, file) so re-renders (e.g. tab focus) don't re-run hljs. */
function HighlightedCode({ text, fileName }: { text: string; fileName: string }) {
  const t = useT();
  // Drop a single trailing newline so the gutter line count matches the rows
  // the <pre> actually renders (editors don't number the phantom final line).
  const body = useMemo(() => (text.endsWith('\n') ? text.slice(0, -1) : text), [text]);
  const html = useMemo(() => highlightCode(body, fileName).html, [body, fileName]);
  const lineCount = useMemo(() => body.split('\n').length, [body]);
  const codeRef = useRef<HTMLElement>(null);
  // The right-click that opens the menu can COLLAPSE the live selection before
  // `contextmenu` fires, so by then `getSelection()` is often already empty —
  // that's why the highlight "disappeared". We continuously remember the last
  // non-empty selection inside this code block and restore it when the menu
  // opens (see CodeContextMenu), so it stays visible and Copy/Search still work.
  const lastSelRef = useRef<{ text: string; range: Range | null }>({ text: '', range: null });
  const [menu, setMenu] = useState<
    { x: number; y: number; selection: string; range: Range | null } | null
  >(null);

  useEffect(() => {
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const code = codeRef.current;
      if (code && code.contains(range.commonAncestorContainer)) {
        lastSelRef.current = { text: sel.toString(), range: range.cloneRange() };
      }
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, []);

  return (
    <div
      className="file-code-scroll"
      onContextMenu={(e: ReactMouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        // Prefer the live selection; fall back to the last tracked one if the
        // right-click already collapsed it.
        const live = window.getSelection();
        const liveText = live?.toString() ?? '';
        const captured =
          liveText && live && live.rangeCount > 0
            ? { text: liveText, range: live.getRangeAt(0).cloneRange() }
            : lastSelRef.current;
        setMenu({ x: e.clientX, y: e.clientY, selection: captured.text, range: captured.range });
      }}
    >
      <div className="file-code-rows">
        <div className="file-gutter" aria-hidden="true">
          {Array.from({ length: Math.max(lineCount, 1) }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <pre className="file-code hljs">
          <code ref={codeRef} dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
      {menu && (
        <CodeContextMenu
          x={menu.x}
          y={menu.y}
          selection={menu.selection}
          range={menu.range}
          codeRef={codeRef}
          onClose={() => setMenu(null)}
          t={t}
        />
      )}
    </div>
  );
}

/** The code viewer's right-click menu. Positioned at the cursor (fixed). */
function CodeContextMenu({
  x,
  y,
  selection,
  range,
  codeRef,
  onClose,
  t,
}: {
  x: number;
  y: number;
  selection: string;
  range: Range | null;
  codeRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  t: TFunc;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hasSelection = selection.trim().length > 0;

  // Re-show the user's selection that the right-click may have collapsed, so
  // the highlight stays visible the whole time the menu is open.
  useEffect(() => {
    if (!range) return;
    const sel = window.getSelection();
    if (!sel) return;
    try {
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* range nodes may have changed — best effort */
    }
  }, [range]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Capture phase so a click anywhere dismisses before it does other work.
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const searchGoogle = () => {
    void api.workspace.openExternal(
      `https://www.google.com/search?q=${encodeURIComponent(selection)}`,
    );
    onClose();
  };
  const copy = () => {
    void api.clipboard.writeText(selection);
    onClose();
  };
  const selectAll = () => {
    const el = codeRef.current;
    const sel = window.getSelection();
    if (el && sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    onClose();
  };

  // Keep the menu inside the viewport (flip up/left near the edges).
  const style: CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 140),
  };

  return (
    <div
      ref={ref}
      className="menu-pop code-context-menu"
      style={style}
      // Keep the text selection intact while the menu is up: mousedown on the
      // menu would otherwise blur the selection (greying its highlight) before
      // the click fires.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button onClick={searchGoogle} disabled={!hasSelection}>
        {t('files.searchGoogle')}
      </button>
      <div className="menu-sep" />
      <button onClick={copy} disabled={!hasSelection}>
        {t('files.copy')}
      </button>
      <button onClick={selectAll}>{t('files.selectAll')}</button>
    </div>
  );
}
