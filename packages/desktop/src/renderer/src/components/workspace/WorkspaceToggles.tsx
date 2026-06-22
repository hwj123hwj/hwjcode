/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two top-right layout toggles (Codex-style): show/hide the bottom terminal
 * panel and the right feature sidebar. Rendered at the right end of the session
 * toolbar (and the empty-screen titlebar), to the left of the OS window controls.
 */

import { useStore } from '../../store';
import { Icon } from '../Icon';
import { useT } from '../../i18n/useT';

export function WorkspaceToggles() {
  const workspace = useStore((s) => s.workspace);
  const toggleBottom = useStore((s) => s.toggleWorkspaceBottom);
  const toggleRight = useStore((s) => s.toggleWorkspaceRight);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const t = useT();

  return (
    <div className="ws-toggles">
      <button
        className={`ws-toggle ${workspace.sidebarOpen ? 'active' : ''}`}
        title={workspace.sidebarOpen ? t('sidebar.collapse') : t('sidebar.expand')}
        aria-pressed={workspace.sidebarOpen}
        onClick={toggleSidebar}
      >
        <Icon name="panel" size={16} />
      </button>
      <button
        className={`ws-toggle ${workspace.bottomOpen ? 'active' : ''}`}
        title={t('workspace.toggleBottom')}
        aria-pressed={workspace.bottomOpen}
        onClick={toggleBottom}
      >
        <Icon name="panel-bottom" size={16} />
      </button>
      <button
        className={`ws-toggle ${workspace.rightOpen ? 'active' : ''}`}
        title={t('workspace.toggleRight')}
        aria-pressed={workspace.rightOpen}
        onClick={toggleRight}
      >
        <Icon name="panel-right" size={16} />
      </button>
    </div>
  );
}
