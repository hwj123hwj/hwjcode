import { useEffect } from 'react';
import { useStore } from './store';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import { PermissionDialog } from './components/PermissionDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { useT } from './i18n/useT';

export function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const auth = useStore((s) => s.auth);
  const lang = useStore((s) => s.lang);
  const t = useT();

  useEffect(() => {
    void init();
  }, [init]);

  // Keep <html lang> in sync for correct font hinting / accessibility.
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

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

  if (!auth.loggedIn) {
    return <Login />;
  }

  return (
    <ErrorBoundary label="app">
      <div className="app">
        <Sidebar />
        {/* Isolate the session view: if a transcript item throws while
            rendering, show an error panel here instead of blanking the whole
            window, and keep the sidebar usable. */}
        <ErrorBoundary label="session">
          <SessionView />
        </ErrorBoundary>
        <PermissionDialog />
      </div>
    </ErrorBoundary>
  );
}
