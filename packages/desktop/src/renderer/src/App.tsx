import { useEffect } from 'react';
import { useStore, type RightView } from './store';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import { PermissionDialog } from './components/PermissionDialog';
import { UpdateBanner } from './components/UpdateBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RightSidebar } from './components/workspace/RightSidebar';
import { BottomTerminal } from './components/workspace/BottomTerminal';
import { terminalStore } from './components/workspace/terminalSession';
import { Resizer } from './components/workspace/Resizer';
import { Icon } from './components/Icon';
import { useT } from './i18n/useT';
import { applyTheme } from './theme';

export function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const auth = useStore((s) => s.auth);
  const customModelOnly = useStore((s) => s.customModelOnly);
  const workspace = useStore((s) => s.workspace);
  const setWorkspaceSize = useStore((s) => s.setWorkspaceSize);
  const lang = useStore((s) => s.lang);
  const theme = useStore((s) => s.theme);
  const t = useT();

  useEffect(() => {
    void init();
  }, [init]);

  // Global workspace shortcuts (Codex parity): reveal a feature view or toggle
  // the bottom terminal. Skipped while typing in an input/textarea so they never
  // hijack the composer. Each maps to the hint shown on its rail item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const s = useStore.getState();
      let view: RightView | null = null;
      if (e.shiftKey && (e.key === 'G' || e.key === 'g')) view = 'review';
      else if (e.altKey && (e.key === 'S' || e.key === 's')) view = 'sidechat';
      else if (!e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T')) view = 'browser';
      else if (!e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) view = 'files';
      else if (!e.shiftKey && !e.altKey && e.key === '`') {
        e.preventDefault();
        s.toggleWorkspaceBottom();
        return;
      }
      if (view) {
        // Ctrl+P is normally the browser's print/quick-open; reclaim it for Files.
        // Don't steal plain typing of these letters — only fire with the modifier.
        if (typing && view === 'files') return;
        e.preventDefault();
        s.openWorkspaceView(view);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep <html lang> in sync for correct font hinting / accessibility.
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  // Reflect the theme choice onto <html data-theme> (drives the CSS palette) and
  // mirror it to the native window chrome (title bar, scrollbars, form controls)
  // via nativeTheme.themeSource in the main process.
  useEffect(() => {
    applyTheme(theme);
    void window.easycode.theme?.set(theme);
    // Re-tint any open integrated terminals to match the new palette.
    terminalStore.applyTheme();
  }, [theme]);

  if (!ready || !auth) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <span className="brand-mark" style={{ width: 40, height: 40, borderRadius: 12 }}>
            <Icon name="sparkle" size={20} />
          </span>
          <span className="spinner" />
          <span>{t('app.booting')}</span>
        </div>
      </div>
    );
  }

  // Auth gate: signed-in users pass, and so do users who opted into
  // custom-model-only mode (their own API keys, no sign-in needed). Everyone
  // else gets the login screen — where they can also enter custom-model mode.
  if (!auth.loggedIn && !customModelOnly) {
    return <Login />;
  }

  return (
    <ErrorBoundary label="app">
      <div className="app">
        <Sidebar />
        {/* The workspace shell stacks the session row (chat + right feature
            sidebar) over the optional bottom terminal panel. */}
        <div className="workspace-shell">
          <div className="workspace-row">
            {/* Isolate the session view: if a transcript item throws while
                rendering, show an error panel here instead of blanking the whole
                window, and keep the sidebar usable. */}
            <ErrorBoundary label="session">
              <SessionView />
            </ErrorBoundary>
            {workspace.rightOpen && (
              <>
                <Resizer
                  axis="x"
                  getValue={() => useStore.getState().workspace.rightWidth}
                  onChange={(v) => setWorkspaceSize('rightWidth', v)}
                />
                <ErrorBoundary label="right-sidebar">
                  <RightSidebar />
                </ErrorBoundary>
              </>
            )}
          </div>
          {workspace.bottomOpen && (
            <>
              <Resizer
                axis="y"
                getValue={() => useStore.getState().workspace.bottomHeight}
                onChange={(v) => setWorkspaceSize('bottomHeight', v)}
              />
              <ErrorBoundary label="bottom-terminal">
                <BottomTerminal />
              </ErrorBoundary>
            </>
          )}
        </div>
        <PermissionDialog />
        <UpdateBanner />
      </div>
    </ErrorBoundary>
  );
}
