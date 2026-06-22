/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Browser — a built-in web browser backed by an Electron <webview> (a separate,
 * out-of-process guest). An address bar, back/forward/reload/home navigation,
 * and an "open in system browser" escape hatch. The guest uses a persistent
 * session partition so logins survive across openings.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { useStore } from '../../store';
import { useT } from '../../i18n/useT';
import type { WebviewElement } from '../../webview';

const HOME_URL = 'https://www.bing.com';

/**
 * Turn whatever the user typed into a navigable URL: keep explicit schemes,
 * promote bare domains to https, and treat everything else as a web search.
 */
function toUrl(input: string): string {
  const s = input.trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s;
  // A token with a dot and no spaces looks like a host (e.g. example.com/path).
  if (/^[^\s]+\.[^\s]+$/.test(s)) return `https://${s}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

export function BrowserPanel() {
  const t = useT();
  const ref = useRef<WebviewElement | null>(null);
  // `url` is the committed URL the webview loads; null until the first navigation
  // (we show a blank prompt until then). `address` is the editable address bar.
  const [url, setUrl] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });

  const navigate = (raw: string) => {
    const next = toUrl(raw);
    if (!next) return;
    setAddress(next);
    // Already mounted → drive the existing webview (preserves session history);
    // otherwise mount it on this URL.
    if (url !== null && ref.current) void ref.current.loadURL(next);
    else setUrl(next);
  };

  // External navigation requests (e.g. clicking a link in the transcript). The
  // `seq` bumps per request so clicking the same URL twice still re-navigates.
  const browserNav = useStore((s) => s.workspace.browserNav);
  useEffect(() => {
    if (browserNav?.url) navigate(browserNav.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserNav?.seq]);

  // Wire webview lifecycle events once it mounts (and re-wire if it remounts).
  useEffect(() => {
    const el = ref.current;
    if (!el || url === null) return;
    const syncNav = () => {
      setAddress(el.getURL());
      setNav({ back: el.canGoBack(), forward: el.canGoForward() });
    };
    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      syncNav();
    };
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', syncNav);
    el.addEventListener('did-navigate-in-page', syncNav);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', syncNav);
      el.removeEventListener('did-navigate-in-page', syncNav);
    };
  }, [url]);

  const openExternal = () => {
    const cur = ref.current?.getURL() || address;
    if (cur) void window.easycode.workspace.openExternal(cur);
  };

  return (
    <div className="ws-panel browser-panel">
      <div className="browser-bar">
        <button
          className="icon-btn"
          title={t('browser.back')}
          disabled={!nav.back}
          onClick={() => ref.current?.goBack()}
        >
          <Icon name="arrow-left" size={16} />
        </button>
        <button
          className="icon-btn"
          title={t('browser.forward')}
          disabled={!nav.forward}
          onClick={() => ref.current?.goForward()}
        >
          <Icon name="arrow-right" size={16} />
        </button>
        <button
          className="icon-btn"
          title={t('browser.reload')}
          onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}
        >
          <Icon name={loading ? 'x' : 'rotate'} size={15} />
        </button>
        <button className="icon-btn" title={t('browser.home')} onClick={() => navigate(HOME_URL)}>
          <Icon name="home" size={15} />
        </button>
        <div className="browser-address">
          <Icon name={address.startsWith('https://') ? 'lock' : 'globe'} size={13} />
          <input
            value={address}
            placeholder={t('browser.placeholder')}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                navigate(address);
              }
            }}
          />
        </div>
        <button className="icon-btn" title={t('browser.openExternal')} onClick={openExternal}>
          <Icon name="external-link" size={15} />
        </button>
      </div>
      <div className="browser-view">
        {url === null ? (
          <div className="empty">{t('browser.blank')}</div>
        ) : (
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            src={url.trim()}
            // `partition` is a valid Electron <webview> attribute, unknown to the
            // DOM-oriented lint rule.
            // eslint-disable-next-line react/no-unknown-property
            partition="persist:browser"
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        )}
      </div>
    </div>
  );
}
