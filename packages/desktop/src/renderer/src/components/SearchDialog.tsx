/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * The search command palette (opened from the sidebar "Search" button). Empty
 * query shows recent chats + suggested actions; typing runs a debounced full-text
 * search over session titles and transcript content (via `sessions.search`) and
 * shows a snippet for each content match. Keyboard: ↑/↓ to move, Enter to open,
 * Esc to close, Ctrl/⌘+1…9 to jump to a result, and the suggested-action
 * accelerators (Ctrl/⌘+N / O / ,).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { Icon, type IconName } from './Icon';
import { useT } from '../i18n/useT';
import type { SessionKind, SessionSearchResult } from '@shared/ipc';

const api = window.easycode;

/** Last path segment of a working directory (handles / and \ separators). */
function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

/** One chat row shown in the palette (recent session or search hit). */
interface ChatRow {
  sessionId: string;
  title: string;
  cwd: string;
  kind: SessionKind;
  snippet?: string;
}

/** A suggested command (shown only when the query is empty). */
interface ActionRow {
  id: 'new' | 'folder' | 'settings';
  label: string;
  icon: IconName;
  accel: string;
  run: () => void;
}

/** Max recent chats surfaced (and the number of Ctrl+N accelerators) when idle. */
const MAX_RECENT = 9;
/** Debounce before firing a content search, so each keystroke doesn't hit disk. */
const SEARCH_DEBOUNCE_MS = 200;

export function SearchDialog({
  onClose,
  onNewChat,
  onOpenFolder,
  onOpenSettings,
}: {
  onClose: () => void;
  onNewChat: () => void;
  onOpenFolder: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const order = useStore((s) => s.order);
  const sessions = useStore((s) => s.sessions);
  const focusSession = useStore((s) => s.focusSession);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();

  // Recent chats (idle state): the newest non-archived sessions from the store.
  const recent = useMemo<ChatRow[]>(() => {
    const rows: ChatRow[] = [];
    for (const id of order) {
      const v = sessions[id];
      if (!v || v.meta.archived) continue;
      rows.push({ sessionId: id, title: v.meta.title, cwd: v.meta.cwd, kind: v.meta.kind });
      if (rows.length >= MAX_RECENT) break;
    }
    return rows;
  }, [order, sessions]);

  // Debounced full-text search whenever the (non-empty) query changes. A request
  // token guards against out-of-order responses clobbering a newer query.
  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void api.sessions
        .search(trimmed)
        .then((r) => {
          if (!cancelled) setResults(r);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed]);

  const openSession = (id: string) => {
    focusSession(id);
    onClose();
  };

  const actions = useMemo<ActionRow[]>(
    () => [
      { id: 'new', label: t('search.newChat'), icon: 'edit', accel: 'Ctrl+N', run: () => { onNewChat(); onClose(); } },
      { id: 'folder', label: t('search.openFolder'), icon: 'folder-open', accel: 'Ctrl+O', run: () => { onOpenFolder(); onClose(); } },
      { id: 'settings', label: t('common.settings'), icon: 'settings', accel: 'Ctrl+,', run: () => { onOpenSettings(); onClose(); } },
    ],
    [t, onNewChat, onOpenFolder, onOpenSettings, onClose],
  );

  // The visible chat rows: search hits while querying, else the recent list.
  const chatRows: ChatRow[] = trimmed
    ? results.map((r) => ({
        sessionId: r.sessionId,
        title: r.title,
        cwd: r.cwd,
        kind: r.kind,
        snippet: r.snippet,
      }))
    : recent;
  // Suggested actions only appear on the idle (empty-query) screen.
  const showActions = !trimmed;
  const totalItems = chatRows.length + (showActions ? actions.length : 0);

  // Keep the selection in range as the visible set changes, and reset to the top
  // on every query change so the first (best) hit is preselected.
  useEffect(() => {
    setSel(0);
  }, [trimmed]);
  useEffect(() => {
    setSel((s) => (totalItems === 0 ? 0 : Math.min(s, totalItems - 1)));
  }, [totalItems]);

  const activate = (index: number) => {
    if (index < chatRows.length) {
      openSession(chatRows[index].sessionId);
    } else if (showActions) {
      actions[index - chatRows.length]?.run();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => (totalItems ? (s + 1) % totalItems : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => (totalItems ? (s - 1 + totalItems) % totalItems : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (totalItems) activate(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.metaKey || e.ctrlKey) {
      // Ctrl/⌘+1…9 → nth chat row; Ctrl/⌘+N / O / , → suggested actions.
      if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < chatRows.length) {
          e.preventDefault();
          openSession(chatRows[i].sessionId);
        }
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        actions[0].run();
      } else if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        actions[1].run();
      } else if (e.key === ',') {
        e.preventDefault();
        actions[2].run();
      }
    }
  };

  // Scroll the selected row into view as the selection moves via the keyboard.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const projectLabel = (row: ChatRow) =>
    row.kind === 'chat' ? t('sidebar.chatsFolder') : projectName(row.cwd);

  const renderChatRow = (row: ChatRow, index: number) => (
    <button
      key={row.sessionId}
      data-idx={index}
      className={`palette-row ${sel === index ? 'active' : ''}`}
      onMouseMove={() => setSel(index)}
      onClick={() => activate(index)}
    >
      <div className="palette-row-main">
        <span className="palette-title">{row.title}</span>
        {row.snippet && <span className="palette-snippet">{row.snippet}</span>}
      </div>
      <span className="palette-project">{projectLabel(row)}</span>
      {index < MAX_RECENT && <span className="palette-accel">Ctrl+{index + 1}</span>}
    </button>
  );

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input">
          <Icon name="search" size={16} className="palette-input-ic" />
          <input
            autoFocus
            value={query}
            placeholder={t('search.placeholder')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="palette-list" ref={listRef}>
          {chatRows.length > 0 && (
            <div className="palette-section">
              <div className="palette-section-title">{t('search.chats')}</div>
              {chatRows.map((row, i) => renderChatRow(row, i))}
            </div>
          )}

          {trimmed && chatRows.length === 0 && !searching && (
            <div className="palette-empty">{t('search.noResults', { query: trimmed })}</div>
          )}
          {trimmed && searching && chatRows.length === 0 && (
            <div className="palette-empty">
              <span className="spinner" /> {t('common.loading')}
            </div>
          )}

          {showActions && (
            <div className="palette-section">
              <div className="palette-section-title">{t('search.suggested')}</div>
              {actions.map((a, i) => {
                const index = chatRows.length + i;
                return (
                  <button
                    key={a.id}
                    data-idx={index}
                    className={`palette-row action ${sel === index ? 'active' : ''}`}
                    onMouseMove={() => setSel(index)}
                    onClick={() => activate(index)}
                  >
                    <Icon name={a.icon} size={15} className="palette-action-ic" />
                    <span className="palette-row-main">
                      <span className="palette-title">{a.label}</span>
                    </span>
                    <span className="palette-accel">{a.accel}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
