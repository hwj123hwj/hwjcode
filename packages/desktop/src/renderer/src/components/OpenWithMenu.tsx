/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Session-toolbar "Open workspace with…" split button. The main segment shows the
 * icon of the program the user last opened a workspace with (name in its tooltip)
 * and launches the session's working directory in it on click; the caret segment
 * opens a dropdown to switch to a different detected program (editors / file
 * managers / terminals).
 *
 * Programs (with their native icons) are detected + icon-extracted in the main
 * process in the background at startup, so this loads them eagerly on mount and the
 * button is ready with no spinner. A program with no extractable icon falls back to
 * a bundled PNG (Windows Terminal) or a generic file glyph.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n/useT';
import type { OpenerInfo } from '@shared/ipc';

const api = window.easycode;

/** The program icon (native/bundled data URL) or a generic glyph fallback. */
function OpenerIcon({ opener }: { opener: OpenerInfo }) {
  return opener.icon ? (
    <img className="opener-ic" src={opener.icon} alt="" width={16} height={16} />
  ) : (
    <Icon name="file" size={14} className="opener-ic-placeholder" />
  );
}

export function OpenWithMenu({ cwd }: { cwd: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [openers, setOpeners] = useState<OpenerInfo[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Load the (background-preloaded) program list + last choice eagerly on mount so
  // the button can show the default program right away.
  useEffect(() => {
    let alive = true;
    void Promise.all([api.workspace.listOpeners(), api.workspace.getLastOpener()]).then(
      ([list, lastId]) => {
        if (!alive) return;
        setOpeners(list);
        // Default to the last-opened program if it's still installed, else the first.
        const fallback = list[0]?.id ?? null;
        setSelectedId(list.some((o) => o.id === lastId) ? lastId : fallback);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // Dismiss the dropdown on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = useMemo(
    () => openers?.find((o) => o.id === selectedId) ?? openers?.[0] ?? null,
    [openers, selectedId],
  );

  const openIn = (id: string) => {
    // Main persists this as the last choice (see openerService); mirror it locally
    // so the button updates immediately.
    setSelectedId(id);
    void api.workspace.openWith(id, cwd);
    setOpen(false);
  };

  // Still loading, or nothing detected — show a disabled placeholder chip.
  if (!selected) {
    return (
      <div ref={ref} style={{ position: 'relative' }}>
        <button className="chip interactive" disabled title={t('session.openWith')}>
          <Icon name="external-link" size={14} />
          <Icon name="chevron-down" size={12} />
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="opener-split" style={{ position: 'relative' }}>
      <button
        className="chip interactive opener-main"
        title={t('session.openIn', { name: selected.name })}
        aria-label={t('session.openIn', { name: selected.name })}
        onClick={() => openIn(selected.id)}
      >
        <OpenerIcon opener={selected} />
      </button>
      <button
        className="chip interactive opener-caret"
        title={t('session.openWithSwitch')}
        aria-label={t('session.openWithSwitch')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="menu-pop opener-menu" style={{ right: 0, top: '110%' }}>
          {openers && openers.length === 0 ? (
            <div className="opener-empty">{t('session.openWithEmpty')}</div>
          ) : (
            openers?.map((o) => (
              <button key={o.id} onClick={() => openIn(o.id)}>
                <OpenerIcon opener={o} />
                <span className="grow">{o.name}</span>
                {o.id === selected.id && <Icon name="check" size={14} />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
