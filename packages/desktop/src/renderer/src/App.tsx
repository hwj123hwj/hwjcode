import { useEffect } from 'react';
import { useStore } from './store';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import { PermissionDialog } from './components/PermissionDialog';
import { Icon } from './components/Icon';

export function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const auth = useStore((s) => s.auth);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready || !auth) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <span className="brand-mark" style={{ width: 40, height: 40, borderRadius: 12 }}>
            <Icon name="sparkle" size={20} />
          </span>
          <span className="spinner" />
          <span>正在启动 Easy Code…</span>
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
