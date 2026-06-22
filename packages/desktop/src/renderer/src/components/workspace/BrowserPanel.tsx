/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Browser — a built-in, MULTI-TAB web browser backed by Electron `<webview>`
 * guests (one per tab, all kept mounted so each tab's history/scroll survives
 * tab switches; only the active one is visible). A tab strip, an address bar,
 * back/forward/reload/home navigation, and an "open in system browser" escape
 * hatch. Tabs live in the global store so opening a link from the transcript
 * (`openInBrowser`) focuses an existing tab or spawns a new one.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { useStore, type BrowserTab } from '../../store';
import { useT, type TFunc } from '../../i18n/useT';
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
  if (/^[^\s]+\.[^\s]+$/.test(s)) return `https://${s}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

/** Short display label for a tab: the page title, else the bare hostname. */
function tabLabel(tab: BrowserTab, fallback: string): string {
  if (tab.title) return tab.title;
  try {
    return new URL(tab.url).hostname.replace(/^www\./, '') || fallback;
  } catch {
    return tab.url || fallback;
  }
}

interface NavState {
  address: string;
  back: boolean;
  forward: boolean;
  loading: boolean;
}

export function BrowserPanel() {
  const t = useT();
  const tabs = useStore((s) => s.workspace.browserTabs);
  const activeId = useStore((s) => s.workspace.activeBrowserTab);
  const newTab = useStore((s) => s.newBrowserTab);
  const closeTab = useStore((s) => s.closeBrowserTab);
  const setActive = useStore((s) => s.setActiveBrowserTab);
  const updateTab = useStore((s) => s.updateBrowserTab);

  // Live webview handles + per-tab nav state, keyed by tab id.
  const webviews = useRef<Map<string, WebviewElement>>(new Map());
  const [nav, setNav] = useState<Record<string, NavState>>({});
  const [address, setAddress] = useState('');

  const active = tabs.find((tt) => tt.id === activeId);
  const activeNav = activeId ? nav[activeId] : undefined;

  // Keep the address bar showing the active tab's current location (unless the
  // user is mid-edit, which doesn't change activeNav so won't get clobbered).
  useEffect(() => {
    setAddress(activeNav?.address ?? active?.url ?? '');
  }, [activeId, activeNav?.address, active?.url]);

  const navigate = (raw: string) => {
    if (!activeId) return;
    const next = toUrl(raw);
    if (!next) return;
    setAddress(next);
    const wv = webviews.current.get(activeId);
    if (wv) void wv.loadURL(next);
    else updateTab(activeId, { url: next }); // blank tab → mounts a webview on `next`
  };

  if (tabs.length === 0) {
    return (
      <div className="ws-panel browser-panel">
        <div className="browser-tabs">
          <button className="browser-tab-new" title={t('browser.newTab')} onClick={() => newTab()}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="empty">{t('browser.blank')}</div>
      </div>
    );
  }

  const wv = () => (activeId ? webviews.current.get(activeId) : undefined);

  return (
    <div className="ws-panel browser-panel">
      <div className="browser-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`browser-tab ${tab.id === activeId ? 'active' : ''}`}
            title={tab.url}
            onClick={() => setActive(tab.id)}
          >
            <Icon name="globe" size={12} />
            <span className="browser-tab-name">{tabLabel(tab, t('browser.newTabTitle'))}</span>
            <button
              className="browser-tab-close"
              title={t('browser.closeTab')}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <button className="browser-tab-new" title={t('browser.newTab')} onClick={() => newTab()}>
          <Icon name="plus" size={14} />
        </button>
      </div>

      <div className="browser-bar">
        <button
          className="icon-btn"
          title={t('browser.back')}
          disabled={!activeNav?.back}
          onClick={() => wv()?.goBack()}
        >
          <Icon name="arrow-left" size={16} />
        </button>
        <button
          className="icon-btn"
          title={t('browser.forward')}
          disabled={!activeNav?.forward}
          onClick={() => wv()?.goForward()}
        >
          <Icon name="arrow-right" size={16} />
        </button>
        <button
          className="icon-btn"
          title={t('browser.reload')}
          onClick={() => (activeNav?.loading ? wv()?.stop() : wv()?.reload())}
        >
          <Icon name={activeNav?.loading ? 'x' : 'rotate'} size={15} />
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
        <button
          className="icon-btn"
          title={t('browser.openExternal')}
          onClick={() => {
            const cur = wv()?.getURL() || address;
            if (cur) void window.easycode.workspace.openExternal(cur);
          }}
        >
          <Icon name="external-link" size={15} />
        </button>
      </div>

      <div className="browser-view">
        {tabs.map((tab) => (
          <BrowserTabView
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            registerRef={(el) => {
              if (el) webviews.current.set(tab.id, el);
              else webviews.current.delete(tab.id);
            }}
            onNav={(st) => setNav((prev) => ({ ...prev, [tab.id]: st }))}
            onMeta={(patch) => updateTab(tab.id, patch)}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A single tab's <webview>. Mounts lazily (a blank tab shows a prompt until its
 * first navigation), keeps a STABLE `src` (in-tab navigation goes through
 * `loadURL`, never a `src` change, so the guest never reloads), and bubbles
 * nav/title/url changes up to the panel + store.
 */
function BrowserTabView({
  tab,
  active,
  registerRef,
  onNav,
  onMeta,
  t,
}: {
  tab: BrowserTab;
  active: boolean;
  registerRef: (el: WebviewElement | null) => void;
  onNav: (st: NavState) => void;
  onMeta: (patch: Partial<Omit<BrowserTab, 'id'>>) => void;
  t: TFunc;
}) {
  const ref = useRef<WebviewElement | null>(null);
  // The URL the <webview> first mounts on. Set once (so React never swaps `src`
  // out from under a live guest); later navigation is driven via loadURL.
  const [mountUrl, setMountUrl] = useState<string | null>(tab.url || null);

  useEffect(() => {
    if (!mountUrl && tab.url) setMountUrl(tab.url);
  }, [tab.url, mountUrl]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !mountUrl) return;
    const snapshot = (loading: boolean): NavState => ({
      address: el.getURL(),
      back: el.canGoBack(),
      forward: el.canGoForward(),
      loading,
    });
    const onStart = () => onNav(snapshot(true));
    const onStop = () => {
      onNav(snapshot(false));
      onMeta({ url: el.getURL() });
    };
    const onNavigate = () => {
      onNav(snapshot(false));
      onMeta({ url: el.getURL() });
    };
    const onTitle = (e: Event) => {
      const title = (e as unknown as { title?: string }).title;
      if (title) onMeta({ title });
    };
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('page-title-updated', onTitle);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('page-title-updated', onTitle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountUrl]);

  return (
    <div className="browser-tab-view" style={{ display: active ? 'flex' : 'none' }}>
      {mountUrl ? (
        <webview
          ref={(el) => {
            ref.current = el as unknown as WebviewElement | null;
            registerRef(el as unknown as WebviewElement | null);
          }}
          src={mountUrl}
          // `partition` is a valid Electron <webview> attribute, unknown to the
          // DOM-oriented lint rule.
          // eslint-disable-next-line react/no-unknown-property
          partition="persist:browser"
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      ) : (
        <div className="empty">{t('browser.blank')}</div>
      )}
    </div>
  );
}
