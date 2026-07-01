/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextMenuTemplate,
  contextMenuLabels,
  type ContextMenuInput,
} from './contextMenu.js';

const en = contextMenuLabels('en');

/** All edit flags on, no selection, not a link — the base for a right-click. */
function input(overrides: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return {
    isEditable: false,
    editFlags: {
      canUndo: true,
      canRedo: true,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
    },
    selectionText: '',
    linkURL: '',
    ...overrides,
  };
}

/** Pull the `role`s (dropping separators) so tests read as the visible actions. */
const roles = (t: ReturnType<typeof buildContextMenuTemplate>) =>
  t.filter((i) => i.role).map((i) => i.role);

describe('buildContextMenuTemplate', () => {
  it('returns the full editing menu for an editable field', () => {
    const t = buildContextMenuTemplate(input({ isEditable: true }), en);
    expect(roles(t)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  });

  it('reflects editFlags as per-item enabled state', () => {
    const t = buildContextMenuTemplate(
      input({
        isEditable: true,
        editFlags: {
          canUndo: false,
          canRedo: false,
          canCut: false,
          canCopy: false,
          canPaste: false,
          canSelectAll: true,
        },
      }),
      en,
    );
    const enabledByRole = Object.fromEntries(
      t.filter((i) => i.role).map((i) => [i.role, i.enabled]),
    );
    expect(enabledByRole).toMatchObject({
      undo: false,
      redo: false,
      cut: false,
      copy: false,
      paste: false,
      selectAll: true,
    });
  });

  it('treats missing canUndo/canRedo as enabled (Electron omits them until edited)', () => {
    const t = buildContextMenuTemplate(
      input({
        isEditable: true,
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      }),
      en,
    );
    const byRole = Object.fromEntries(t.filter((i) => i.role).map((i) => [i.role, i.enabled]));
    expect(byRole.undo).toBe(true);
    expect(byRole.redo).toBe(true);
  });

  it('shows copy-only for a non-editable selection', () => {
    const t = buildContextMenuTemplate(input({ selectionText: 'hello' }), en);
    expect(roles(t)).toEqual(['copy']);
  });

  it('ignores a whitespace-only selection', () => {
    const t = buildContextMenuTemplate(input({ selectionText: '   \n\t' }), en);
    expect(t).toEqual([]);
  });

  it('returns no menu for non-editable text with no selection', () => {
    expect(buildContextMenuTemplate(input(), en)).toEqual([]);
  });

  it('returns no menu on a link (renderer handles link menus)', () => {
    // Even with a selection + editable, a link URL defers to the renderer.
    const t = buildContextMenuTemplate(
      input({ isEditable: true, selectionText: 'x', linkURL: 'https://example.com' }),
      en,
    );
    expect(t).toEqual([]);
  });

  it('applies localized labels to the roles', () => {
    const zh = contextMenuLabels('zh');
    const t = buildContextMenuTemplate(input({ isEditable: true }), zh);
    const copy = t.find((i) => i.role === 'copy');
    const paste = t.find((i) => i.role === 'paste');
    expect(copy?.label).toBe('复制');
    expect(paste?.label).toBe('粘贴');
  });
});
