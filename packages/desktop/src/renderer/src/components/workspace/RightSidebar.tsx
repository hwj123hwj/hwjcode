/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * The right feature sidebar (Codex-style): a vertical function list (the rail)
 * plus a content panel showing the active feature. The rail entries —
 * Review / Terminal / Browser / Files / Side chat — show an icon, a name and a
 * keyboard-shortcut hint. Selecting one switches the content panel; Terminal is
 * special-cased to toggle the bottom panel instead of the content area.
 */

import type { ReactNode } from 'react';
import { useStore, type RightView } from '../../store';
import { Icon, type IconName } from '../Icon';
import { useT, type TFunc } from '../../i18n/useT';
import { ReviewPanel } from './ReviewPanel';
import { FilesPanel } from './FilesPanel';
import { BrowserPanel } from './BrowserPanel';
import { SideChatPanel } from './SideChatPanel';

/** One rail entry. `view` is undefined for Terminal, which toggles the bottom bar. */
interface RailItem {
  key: string;
  icon: IconName;
  labelKey: 'workspace.review' | 'workspace.terminal' | 'workspace.browser' | 'workspace.files' | 'workspace.sidechat';
  shortcut: string;
  view?: RightView;
}

const RAIL: RailItem[] = [
  { key: 'review', icon: 'review', labelKey: 'workspace.review', shortcut: 'Ctrl+Shift+G', view: 'review' },
  { key: 'terminal', icon: 'terminal', labelKey: 'workspace.terminal', shortcut: 'Ctrl+`' },
  { key: 'browser', icon: 'globe', labelKey: 'workspace.browser', shortcut: 'Ctrl+T', view: 'browser' },
  { key: 'files', icon: 'folder', labelKey: 'workspace.files', shortcut: 'Ctrl+P', view: 'files' },
  { key: 'sidechat', icon: 'split', labelKey: 'workspace.sidechat', shortcut: 'Ctrl+Alt+S', view: 'sidechat' },
];

export function RightSidebar() {
  const rightView = useStore((s) => s.workspace.rightView);
  const bottomOpen = useStore((s) => s.workspace.bottomOpen);
  const rightWidth = useStore((s) => s.workspace.rightWidth);
  const openView = useStore((s) => s.openWorkspaceView);
  const toggleBottom = useStore((s) => s.toggleWorkspaceBottom);
  const t = useT();

  let content: ReactNode = null;
  if (rightView === 'review') content = <ReviewPanel />;
  else if (rightView === 'browser') content = <BrowserPanel />;
  else if (rightView === 'files') content = <FilesPanel />;
  else if (rightView === 'sidechat') content = <SideChatPanel />;

  // With a feature open the rail shrinks to an icon-only activity bar (labels
  // live in tooltips) and the content panel takes the draggable width; in
  // launcher mode (no view) the rail expands with labels and sizes itself.
  const hasContent = rightView != null;

  return (
    <div
      className={`rsidebar ${hasContent ? '' : 'launcher'}`}
      style={hasContent ? { flexBasis: rightWidth, width: rightWidth } : undefined}
    >
      {hasContent && <div className="rsidebar-content">{content}</div>}
      <RightRail
        items={RAIL}
        rightView={rightView}
        bottomOpen={bottomOpen}
        collapsed={hasContent}
        onSelect={(item) => (item.view ? openView(item.view) : toggleBottom())}
        t={t}
      />
    </div>
  );
}

function RightRail({
  items,
  rightView,
  bottomOpen,
  collapsed,
  onSelect,
  t,
}: {
  items: RailItem[];
  rightView: RightView | null;
  bottomOpen: boolean;
  collapsed: boolean;
  onSelect: (item: RailItem) => void;
  t: TFunc;
}) {
  return (
    <nav className={`rsidebar-rail ${collapsed ? 'collapsed' : ''}`}>
      {items.map((item) => {
        const active = item.view ? rightView === item.view : bottomOpen;
        return (
          <button
            key={item.key}
            className={`rail-item ${active ? 'active' : ''}`}
            onClick={() => onSelect(item)}
            title={`${t(item.labelKey)} · ${item.shortcut}`}
          >
            <Icon name={item.icon} size={18} />
            <span className="rail-label">{t(item.labelKey)}</span>
            <span className="rail-shortcut">{item.shortcut}</span>
          </button>
        );
      })}
    </nav>
  );
}
