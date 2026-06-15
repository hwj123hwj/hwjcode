import { useMemo, useState } from 'react';
import { useStore, type SessionView } from '../store';
import { NewSessionDialog } from './NewSessionDialog';
import { SettingsDialog } from './SettingsDialog';
import { Icon } from './Icon';
import type { SessionMeta } from '@shared/ipc';

const api = window.easycode;

function initials(name?: string): string {
  if (!name) return '?';
  return name.trim().slice(0, 1).toUpperCase();
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

export function Sidebar() {
  const order = useStore((s) => s.order);
  const sessions = useStore((s) => s.sessions);
  const active = useStore((s) => s.activeSessionId);
  const focusSession = useStore((s) => s.focusSession);
  const archive = useStore((s) => s.archiveSession);
  const auth = useStore((s) => s.auth);
  const filter = useStore((s) => s.sidebarFilter);
  const setFilter = useStore((s) => s.setSidebarFilter);

  const [showNew, setShowNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const grouped = useMemo(() => {
    const views = order.map((id) => sessions[id]).filter(Boolean) as SessionView[];
    const filtered = views.filter((v) => {
      if (filter.status === 'active' && v.meta.archived) return false;
      if (filter.status === 'archived' && !v.meta.archived) return false;
      if (filter.query && !v.meta.title.toLowerCase().includes(filter.query.toLowerCase())) {
        return false;
      }
      return true;
    });
    const groups = new Map<string, SessionView[]>();
    for (const v of filtered) {
      const key = projectName(v.meta.cwd);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(v);
    }
    return [...groups.entries()];
  }, [order, sessions, filter]);

  const onClick = (meta: SessionMeta) => {
    // focusSession resumes (respawns backend + replays history) when the session
    // has no live bridge this run, and just focuses it when it does. This is
    // what reconnects a session after the app was closed and reopened.
    focusSession(meta.id);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="sparkle" size={15} />
          </span>
          Easy Code
        </div>
        <button className="btn-new" onClick={() => setShowNew(true)}>
          <Icon name="plus" size={15} />
          新建会话
        </button>
      </div>

      <div className="sidebar-filters">
        <div className="seg">
          {(['active', 'all', 'archived'] as const).map((st) => (
            <button
              key={st}
              className={filter.status === st ? 'active' : ''}
              onClick={() => setFilter({ status: st })}
            >
              {st === 'active' ? '进行中' : st === 'all' ? '全部' : '已归档'}
            </button>
          ))}
        </div>
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={14} />
        <input
          placeholder="搜索会话…"
          value={filter.query}
          onChange={(e) => setFilter({ query: e.target.value })}
        />
      </div>

      <div className="session-list">
        {grouped.length === 0 && <div className="group-label">暂无会话</div>}
        {grouped.map(([project, views]) => (
          <div key={project}>
            <div className="group-label">{project}</div>
            {views.map((v) => (
              <div
                key={v.meta.id}
                className={`session-item ${active === v.meta.id ? 'active' : ''}`}
                onClick={() => onClick(v.meta)}
              >
                <div className="session-row">
                  <span className={`status-dot ${v.meta.status}`} />
                  <span className="session-title">{v.meta.title}</span>
                </div>
                <div className="session-row">
                  <span className="session-sub">{relTime(v.meta.updatedAt)}</span>
                  {(v.meta.added > 0 || v.meta.removed > 0) && (
                    <span className="diff-chip">
                      <span className="add">+{v.meta.added}</span>{' '}
                      <span className="del">-{v.meta.removed}</span>
                    </span>
                  )}
                </div>
                <div className="session-actions">
                  <button
                    className="icon-btn"
                    title={v.meta.archived ? '取消归档' : '归档'}
                    onClick={(e) => {
                      e.stopPropagation();
                      void archive(v.meta.id, !v.meta.archived);
                    }}
                  >
                    <Icon name={v.meta.archived ? 'archive-restore' : 'archive'} size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <span className="avatar">
          {auth?.user?.avatar ? <img src={auth.user.avatar} alt="" /> : initials(auth?.user?.name)}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {auth?.user?.name || auth?.user?.email || '已登录'}
        </span>
        <button className="icon-btn" title="设置" onClick={() => setShowSettings(true)}>
          <Icon name="settings" size={15} />
        </button>
        <button className="icon-btn" title="退出登录" onClick={() => void api.auth.logout()}>
          <Icon name="power" size={15} />
        </button>
      </div>

      {showNew && <NewSessionDialog onClose={() => setShowNew(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </aside>
  );
}
