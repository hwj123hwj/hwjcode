/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bottom terminal panel: multiple real-PTY shell tabs rendered with xterm.js, so
 * the experience matches VSCode's integrated terminal (cursor, colours, full TUIs
 * like vim, paste, resize). The xterm instances live in the terminalStore
 * singleton so they survive panel toggles; this component only re-parents the
 * active tab's host element into the visible DOM and keeps it fitted.
 */

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { useT } from '../../i18n/useT';
import { terminalStore } from './terminalSession';
import '@xterm/xterm/css/xterm.css';

export function BottomTerminal() {
  const toggleBottom = useStore((s) => s.toggleWorkspaceBottom);
  const bottomHeight = useStore((s) => s.workspace.bottomHeight);
  const activeId = useStore((s) => s.activeSessionId);
  const cwd = useStore((s) => {
    const m = activeId ? s.sessions[activeId]?.meta : undefined;
    return m && m.kind === 'project' ? m.cwd : undefined;
  });
  const t = useT();

  const terms = useSyncExternalStore(terminalStore.subscribe, terminalStore.getTerms);
  const activeTermId = useSyncExternalStore(terminalStore.subscribe, terminalStore.getActiveId);
  const active = terms.find((x) => x.id === activeTermId) ?? terms[0];

  const hostRef = useRef<HTMLDivElement>(null);

  // Spawn the first shell when the panel first appears with none open.
  useEffect(() => {
    if (terms.length === 0) void terminalStore.create(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-parent the active tab's xterm host element into the visible container,
  // then fit it to the available space and focus it. Runs whenever the active
  // tab changes (or the panel is reopened and this component remounts).
  useLayoutEffect(() => {
    const host = hostRef.current;
    const term = active ? terminalStore.getTerm(active.id) : undefined;
    if (!host || !term) return;
    if (term.container.parentElement !== host) {
      host.replaceChildren(term.container);
    }
    terminalStore.fit(active.id);
    terminalStore.focus(active.id);
  }, [active?.id]);

  // Keep the active terminal fitted as the panel (or window) is resized — e.g.
  // when the user drags the bottom-panel resizer.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (active) terminalStore.fit(active.id);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [active?.id]);

  return (
    <div className="bottom-terminal" style={{ height: bottomHeight }}>
      <div className="bterm-tabs">
        <Icon name="terminal" size={14} />
        {terms.map((term) => (
          <div
            key={term.id}
            className={`bterm-tab ${active?.id === term.id ? 'active' : ''}`}
            onClick={() => terminalStore.setActive(term.id)}
          >
            <span className="bterm-tab-name">
              {t('terminalPanel.tab', { n: term.title })}
              {term.exited ? ' ·' : ''}
            </span>
            <button
              className="bterm-tab-close"
              title={t('terminalPanel.close')}
              onClick={(e) => {
                e.stopPropagation();
                terminalStore.close(term.id);
              }}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <button
          className="icon-btn"
          title={t('terminalPanel.new')}
          onClick={() => void terminalStore.create(cwd)}
        >
          <Icon name="plus" size={15} />
        </button>
        <span className="grow" />
        <button className="icon-btn" title={t('terminalPanel.close')} onClick={toggleBottom}>
          <Icon name="chevron-down" size={16} />
        </button>
      </div>

      <div className="bterm-body" ref={hostRef} onMouseDown={() => active && terminalStore.focus(active.id)} />
    </div>
  );
}
