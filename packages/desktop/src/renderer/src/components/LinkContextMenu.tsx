/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Right-click menu for a URL in the chat transcript. Rendered once at app level;
 * any Markdown link populates `store.linkMenu` (url + cursor position) on
 * contextmenu, and this reads it. Actions: open in the built-in browser, open
 * in the system browser, or copy the link.
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import { useStore } from '../store';
import { useT } from '../i18n/useT';

const api = window.easycode;

export function LinkContextMenu() {
  const menu = useStore((s) => s.linkMenu);
  const close = useStore((s) => s.closeLinkMenu);
  const openInBrowser = useStore((s) => s.openInBrowser);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu, close]);

  if (!menu) return null;

  const style: CSSProperties = {
    position: 'fixed',
    left: Math.min(menu.x, window.innerWidth - 220),
    top: Math.min(menu.y, window.innerHeight - 150),
  };

  return (
    <div ref={ref} className="menu-pop code-context-menu" style={style}>
      <button
        onClick={() => {
          openInBrowser(menu.url);
          close();
        }}
      >
        {t('link.openHere')}
      </button>
      <button
        onClick={() => {
          void api.workspace.openExternal(menu.url);
          close();
        }}
      >
        {t('link.openExternal')}
      </button>
      <div className="menu-sep" />
      <button
        onClick={() => {
          void api.clipboard.writeText(menu.url);
          close();
        }}
      >
        {t('link.copy')}
      </button>
    </div>
  );
}
