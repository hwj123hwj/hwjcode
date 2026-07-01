/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Native right-click (context) menu for the main window: cut/copy/paste/select-all
 * for editable fields (the prompt box, message-edit box, terminals) and copy for
 * any selected text in the transcript. Kept as a pure template builder here so it
 * is unit-testable without pulling in `electron` — `index.ts` turns the template
 * into a real `Menu` and pops it up.
 *
 * Links are intentionally skipped: the renderer already shows its own in-app
 * `LinkContextMenu` (open here / open externally / copy link) for Markdown links,
 * so letting the native menu fire too would double up.
 *
 * The standard editing shortcuts (Ctrl/Cmd+C/V/X/A, undo/redo) keep working
 * without any accelerator wiring — Chromium handles them natively inside editable
 * elements and for copying a page selection — so this only adds the mouse path.
 */

import type { MenuItemConstructorOptions } from 'electron';
import type { TrayLang } from './trayLabels.js';

/** The subset of Electron's `editFlags` we consult when building the menu. */
export interface EditFlags {
  canUndo?: boolean;
  canRedo?: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
}

/** The subset of Electron's `ContextMenuParams` the template depends on. */
export interface ContextMenuInput {
  isEditable: boolean;
  editFlags: EditFlags;
  selectionText: string;
  /** Set when the click landed on a link; those are handled by the renderer. */
  linkURL: string;
}

/** Localized labels for the standard editing items. */
export interface ContextMenuLabels {
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
}

const LABELS: Record<TrayLang, ContextMenuLabels> = {
  zh: {
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
  },
  en: {
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
  },
};

/** Localized context-menu labels for the given language. */
export function contextMenuLabels(lang: TrayLang): ContextMenuLabels {
  return LABELS[lang];
}

/**
 * Build the native context-menu template for a right-click.
 *
 *  - On a link → `[]` (the renderer's own menu handles it; don't double up).
 *  - On an editable field → undo / redo / cut / copy / paste / select-all, each
 *    enabled per `editFlags` so unavailable actions grey out instead of no-op.
 *  - On non-editable text with a selection → copy only.
 *  - Otherwise → `[]` (no menu), so callers know to skip `popup()`.
 *
 * Uses `role`-based items so Electron performs the action against the focused
 * element (real system-clipboard cut/copy/paste), with our labels overriding the
 * roles' English defaults for localization.
 */
export function buildContextMenuTemplate(
  input: ContextMenuInput,
  labels: ContextMenuLabels,
): MenuItemConstructorOptions[] {
  if (input.linkURL) return [];

  const { isEditable, editFlags, selectionText } = input;

  if (isEditable) {
    return [
      { role: 'undo', label: labels.undo, enabled: editFlags.canUndo !== false },
      { role: 'redo', label: labels.redo, enabled: editFlags.canRedo !== false },
      { type: 'separator' },
      { role: 'cut', label: labels.cut, enabled: editFlags.canCut },
      { role: 'copy', label: labels.copy, enabled: editFlags.canCopy },
      { role: 'paste', label: labels.paste, enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: labels.selectAll, enabled: editFlags.canSelectAll },
    ];
  }

  if (selectionText.trim().length > 0) {
    return [{ role: 'copy', label: labels.copy, enabled: editFlags.canCopy }];
  }

  return [];
}
