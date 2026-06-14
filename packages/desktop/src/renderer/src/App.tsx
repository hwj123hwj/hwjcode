import { useEffect } from 'react';
import { useStore } from './store';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import { PermissionDialog } from './components/PermissionDialog';

export function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const auth = useStore((s) => s.auth);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready || !auth) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>
            <span className="dot" style={{ width: 18, height: 18, borderRadius: 6, background: 'var(--accent)' }} />
            Easy Code
          </h1>
          <p className="tagline">正在启动…</p>
        </div>
      </div>
    );
  }

  if (!auth.loggedIn) {
    return <Login />;
  }

  return (
    <div className="app">
      <Sidebar />
      <SessionView />
      <PermissionDialog />
    </div>
  );
}
