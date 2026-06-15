import { useEffect, useMemo, useState } from 'react';
import { useStore, type SessionView } from '../store';
import { NewSessionDialog } from './NewSessionDialog';
import { SettingsDialog } from './SettingsDialog';
import { FeishuDialog } from './FeishuDialog';
import { Icon } from './Icon';
import { AgentIcon } from './AgentIcon';
import { useT, type TFunc } from '../i18n/useT';
import appIcon from '../../../public/app-icon.png';
import feishuIcon from '../../../public/feishu_logo.png';
import type { AgentKind, SessionMeta } from '@shared/ipc';

const api = window.easycode;

/** Short text badge shown on each session card, by agent backend. */
const AGENT_LABEL: Record<AgentKind, string> = {
  'easy-code': 'Easy Code',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

function initials(name?: string): string {
  if (!name) return '?';
  return name.trim().slice(0, 1).toUpperCase();
}

function relTime(t: TFunc, ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('time.justNow');
  if (m < 60) return t('time.minutesAgo', { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.hoursAgo', { h });
  return t('time.daysAgo', { d: Math.floor(h / 24) });
}

function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

/** A project bucket in the sidebar: its cwd (stable key), display name, sessions. */
interface ProjectGroup {
  cwd: string;
  name: string;
  views: SessionView[];
}

export function Sidebar() {
  const order = useStore((s) => s.order);
  const sessions = useStore((s) => s.sessions);
  const active = useStore((s) => s.activeSessionId);
  const focusSession = useStore((s) => s.focusSession);
  const archive = useStore((s) => s.archiveSession);
  const rename = useStore((s) => s.renameSession);
  const auth = useStore((s) => s.auth);
  const customModelOnly = useStore((s) => s.customModelOnly);
  const exitCustomModelMode = useStore((s) => s.exitCustomModelMode);
  const filter = useStore((s) => s.sidebarFilter);
  const setFilter = useStore((s) => s.setSidebarFilter);
  const t = useT();

  const [showNew, setShowNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFeishu, setShowFeishu] = useState(false);
  const [feishuRunning, setFeishuRunning] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Project groups the user has collapsed (keyed by full cwd). Default expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (cwd: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  // Keep the footer Feishu icon in sync with the gateway: grayscale when
  // stopped, full color while it runs.
  useEffect(() => {
    void api.feishu.status().then((s) => setFeishuRunning(!!s.running));
    const off = api.feishu.onChanged((s) => setFeishuRunning(!!s.running));
    return () => off();
  }, []);

  const startEdit = (meta: SessionMeta) => {
    setEditingId(meta.id);
    setDraft(meta.title);
  };
  const commitEdit = (id: string) => {
    const title = draft.trim();
    setEditingId(null);
    if (title) void rename(id, title);
  };

  const { chats, projects } = useMemo(() => {
    const views = order.map((id) => sessions[id]).filter(Boolean) as SessionView[];
    const filtered = views.filter((v) => {
      if (filter.status === 'active' && v.meta.archived) return false;
      if (filter.status === 'archived' && !v.meta.archived) return false;
      if (filter.query && !v.meta.title.toLowerCase().includes(filter.query.toLowerCase())) {
        return false;
      }
      return true;
    });
    const chatViews: SessionView[] = [];
    // Key project groups by full cwd (not basename) so two different paths that
    // share a final segment don't collapse into one group.
    const projectMap = new Map<string, ProjectGroup>();
    for (const v of filtered) {
      if (v.meta.kind === 'chat') {
        chatViews.push(v);
        continue;
      }
      const cwd = v.meta.cwd;
      let g = projectMap.get(cwd);
      if (!g) {
        g = { cwd, name: projectName(cwd), views: [] };
        projectMap.set(cwd, g);
      }
      g.views.push(v);
    }
    return { chats: chatViews, projects: [...projectMap.values()] };
  }, [order, sessions, filter]);

  const onClick = (meta: SessionMeta) => {
    // focusSession resumes (respawns backend + replays history) when the session
    // has no live bridge this run, and just focuses it when it does. This is
    // what reconnects a session after the app was closed and reopened.
    focusSession(meta.id);
  };

  // One session card. `nested` adds left indent for sessions shown under a
  // project header (vs. the flat Chats list).
  const renderCard = (v: SessionView, nested: boolean) => (
    <div
      key={v.meta.id}
      className={`session-item ${nested ? 'nested' : ''} ${active === v.meta.id ? 'active' : ''}`}
      onClick={() => onClick(v.meta)}
    >
      <div className="session-row">
        <span className={`status-dot ${v.meta.status}`} />
        {editingId === v.meta.id ? (
          <input
            className="session-title-edit"
            value={draft}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitEdit(v.meta.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitEdit(v.meta.id);
              } else if (e.key === 'Escape') {
                setEditingId(null);
              }
            }}
          />
        ) : (
          <span
            className="session-title"
            title={t('sidebar.dblClickRename')}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startEdit(v.meta);
            }}
          >
            {v.meta.title}
          </span>
        )}
      </div>
      <div className="session-row">
        <span className="session-sub">{relTime(t, v.meta.updatedAt)}</span>
        {(v.meta.added > 0 || v.meta.removed > 0) && (
          <span className="diff-chip">
            <span className="add">+{v.meta.added}</span>{' '}
            <span className="del">-{v.meta.removed}</span>
          </span>
        )}
        {/* Easy Code is the default backend — only badge the others, and
            keep the badge on this second row so it never overlaps the
            hover edit/archive actions pinned to the card's top-right. */}
        {v.meta.agentType !== 'easy-code' && (
          <span className="agent-badge">
            <AgentIcon agent={v.meta.agentType} size={12} />
            {AGENT_LABEL[v.meta.agentType]}
          </span>
        )}
      </div>
      <div className="session-actions">
        <button
          className="icon-btn"
          title={t('common.rename')}
          onClick={(e) => {
            e.stopPropagation();
            startEdit(v.meta);
          }}
        >
          <Icon name="edit" size={14} />
        </button>
        <button
          className="icon-btn"
          title={v.meta.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
          onClick={(e) => {
            e.stopPropagation();
            void archive(v.meta.id, !v.meta.archived);
          }}
        >
          <Icon name={v.meta.archived ? 'archive-restore' : 'archive'} size={14} />
        </button>
      </div>
    </div>
  );

  const isEmpty = chats.length === 0 && projects.length === 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <img className="brand-mark" src={appIcon} alt="Easy Code" />
          Easy Code
        </div>
        <div className="brand-version">v{__APP_VERSION__}</div>
        <button className="btn-new" onClick={() => setShowNew(true)}>
          <Icon name="plus" size={15} />
          {t('sidebar.newSession')}
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
              {t(`sidebar.${st}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={14} />
        <input
          placeholder={t('sidebar.searchPlaceholder')}
          value={filter.query}
          onChange={(e) => setFilter({ query: e.target.value })}
        />
      </div>

      <div className="session-list">
        {isEmpty && <div className="group-label">{t('sidebar.noSessions')}</div>}

        {chats.length > 0 && (
          <div className="sidebar-section">
            <div className="group-label">{t('sidebar.chats')}</div>
            {chats.map((v) => renderCard(v, false))}
          </div>
        )}

        {projects.length > 0 && (
          <div className="sidebar-section">
            <div className="group-label">{t('sidebar.projects')}</div>
            {projects.map((g) => {
              const isCollapsed = collapsed.has(g.cwd);
              return (
                <div key={g.cwd} className="project-group">
                  <button
                    className="project-header"
                    title={g.cwd}
                    onClick={() => toggleCollapse(g.cwd)}
                  >
                    <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                    <Icon name="folder" size={14} />
                    <span className="project-name">{g.name}</span>
                    <span className="project-count">{g.views.length}</span>
                  </button>
                  {!isCollapsed && g.views.map((v) => renderCard(v, true))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="sidebar-foot">
        <span className="avatar">
          {auth?.user?.avatar ? (
            <img src={auth.user.avatar} alt="" />
          ) : customModelOnly ? (
            <Icon name="cpu" size={14} />
          ) : (
            initials(auth?.user?.name)
          )}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {auth?.user?.name ||
            auth?.user?.email ||
            (customModelOnly ? t('sidebar.customModelMode') : t('sidebar.loggedIn'))}
        </span>
        <button
          className="icon-btn"
          title={feishuRunning ? t('sidebar.feishuRunning') : t('sidebar.feishu')}
          onClick={() => setShowFeishu(true)}
        >
          <img
            className={`feishu-ic${feishuRunning ? '' : ' off'}`}
            src={feishuIcon}
            alt={t('feishu.platformFeishu')}
            width={16}
            height={16}
          />
        </button>
        <button className="icon-btn" title={t('common.settings')} onClick={() => setShowSettings(true)}>
          <Icon name="settings" size={15} />
        </button>
        <button
          className="icon-btn"
          title={customModelOnly ? t('sidebar.exitCustomModelMode') : t('common.logout')}
          onClick={() => (customModelOnly ? exitCustomModelMode() : void api.auth.logout())}
        >
          <Icon name="power" size={15} />
        </button>
      </div>

      {showNew && <NewSessionDialog onClose={() => setShowNew(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showFeishu && <FeishuDialog onClose={() => setShowFeishu(false)} />}
    </aside>
  );
}
