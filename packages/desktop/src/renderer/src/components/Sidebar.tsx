import { useEffect, useMemo, useState } from 'react';
import { useStore, type SessionView } from '../store';
import { NewSessionDialog } from './NewSessionDialog';
import { SearchDialog } from './SearchDialog';
import { SettingsDialog, type SectionId } from './SettingsDialog';
import { FeishuDialog } from './FeishuDialog';
import { Icon } from './Icon';
import { AgentIcon } from './AgentIcon';
import { useT, type TFunc } from '../i18n/useT';
import appIcon from '../../../public/logo_black.png';
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

/** Collapse-state key for the single Chats folder group (never a real cwd). */
const CHATS_GROUP_KEY = '__chats__';

export function Sidebar() {
  const order = useStore((s) => s.order);
  const sessions = useStore((s) => s.sessions);
  const active = useStore((s) => s.activeSessionId);
  const focusSession = useStore((s) => s.focusSession);
  const archive = useStore((s) => s.archiveSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const rename = useStore((s) => s.renameSession);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const auth = useStore((s) => s.auth);
  const customModelOnly = useStore((s) => s.customModelOnly);
  const exitCustomModelMode = useStore((s) => s.exitCustomModelMode);
  const createChatSession = useStore((s) => s.createChatSession);
  const t = useT();

  const [showNew, setShowNew] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SectionId>('general');
  const [showFeishu, setShowFeishu] = useState(false);
  const [feishuRunning, setFeishuRunning] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // The archived session pending a delete confirmation (null = no prompt open).
  const [confirmDelete, setConfirmDelete] = useState<SessionMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
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

  const confirmDeleteNow = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await deleteSession(confirmDelete.id);
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const { chats, projects } = useMemo(() => {
    const views = order.map((id) => sessions[id]).filter(Boolean) as SessionView[];
    // The sidebar now shows only active sessions; archived chats are managed in
    // Settings → Archived chats. Title search moved to the search palette.
    const filtered = views.filter((v) => !v.meta.archived);
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
  }, [order, sessions]);

  const onClick = (meta: SessionMeta) => {
    // focusSession resumes (respawns backend + replays history) when the session
    // has no live bridge this run, and just focuses it when it does. This is
    // what reconnects a session after the app was closed and reopened.
    focusSession(meta.id);
  };

  // Title text, or the inline rename input while this session is being edited.
  const renderTitle = (v: SessionView) =>
    editingId === v.meta.id ? (
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
    );

  // Hover actions pinned to the card's top-right: rename, (un)archive, and —
  // for archived sessions only — a permanent delete (gated by a confirm).
  const renderActions = (v: SessionView) => (
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
      {v.meta.archived && (
        <button
          className="icon-btn danger"
          title={t('sidebar.delete')}
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDelete(v.meta);
          }}
        >
          <Icon name="delete" size={14} />
        </button>
      )}
    </div>
  );

  // A project session card: two rows (status + title; then time + diff +
  // backend badge). `nested` indents it under its project header.
  const renderCard = (v: SessionView, nested: boolean) => (
    <div
      key={v.meta.id}
      className={`session-item ${nested ? 'nested' : ''} ${active === v.meta.id ? 'active' : ''}`}
      onClick={() => onClick(v.meta)}
    >
      {/* Single compact line, matching the chat cards: status dot + title,
          then the relative time on the right. The +N/-M diff is a per-project
          value (git diff of the shared working tree), not per-session, so it's
          no longer shown here — it lives inside the session view instead. Only
          non-default backends get a small inline badge. */}
      <div className="session-row">
        <span className={`status-dot ${v.meta.status}`} />
        {renderTitle(v)}
        {v.meta.agentType !== 'easy-code' && (
          <span className="agent-badge">
            <AgentIcon agent={v.meta.agentType} size={12} />
            {AGENT_LABEL[v.meta.agentType]}
          </span>
        )}
        <span className="session-time">{relTime(t, v.meta.updatedAt)}</span>
      </div>
      {renderActions(v)}
    </div>
  );

  // A chat session card: a single compact line — title left (ellipsis), the
  // relative time right (small + dim). Hover reveals the same actions.
  const renderChatCard = (v: SessionView) => (
    <div
      key={v.meta.id}
      className={`session-item chat-item nested ${active === v.meta.id ? 'active' : ''}`}
      onClick={() => onClick(v.meta)}
    >
      <div className="session-row">
        {renderTitle(v)}
        <span className="session-time">{relTime(t, v.meta.updatedAt)}</span>
      </div>
      {renderActions(v)}
    </div>
  );

  const isEmpty = chats.length === 0 && projects.length === 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button
          className="icon-btn sidebar-collapse-btn"
          title={t('sidebar.collapse')}
          onClick={toggleSidebar}
        >
          <Icon name="panel" size={16} />
        </button>
        <div className="brand">
          <img className="brand-mark" src={appIcon} alt="Easy Code" />
          Easy Code
        </div>
        <button
          type="button"
          className="brand-version"
          title={t('settings.navAbout')}
          onClick={() => {
            setSettingsTab('about');
            setShowSettings(true);
          }}
        >
          v{__APP_VERSION__}
        </button>
      </div>

      <div className="sidebar-actions">
        <button className="sidebar-action" onClick={() => setShowNew(true)}>
          <Icon name="edit" size={16} />
          {t('sidebar.newChat')}
        </button>
        <button className="sidebar-action" onClick={() => setShowSearch(true)}>
          <Icon name="search" size={16} />
          {t('sidebar.search')}
        </button>
      </div>

      <div className="session-list">
        {isEmpty && <div className="group-label">{t('sidebar.noSessions')}</div>}

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

        {chats.length > 0 && (
          <div className="sidebar-section">
            <div className="group-label">{t('sidebar.chats')}</div>
            {(() => {
              const isCollapsed = collapsed.has(CHATS_GROUP_KEY);
              return (
                <div className="project-group">
                  <button
                    className="project-header"
                    onClick={() => toggleCollapse(CHATS_GROUP_KEY)}
                  >
                    <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                    <Icon name="folder" size={14} />
                    <span className="project-name">{t('sidebar.chatsFolder')}</span>
                    <span className="project-count">{chats.length}</span>
                  </button>
                  {!isCollapsed && chats.map((v) => renderChatCard(v))}
                </div>
              );
            })()}
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
        <button
          className="icon-btn"
          title={t('common.settings')}
          onClick={() => {
            setSettingsTab('general');
            setShowSettings(true);
          }}
        >
          <Icon name="settings" size={15} />
        </button>
        <button
          className="icon-btn"
          title={customModelOnly ? t('sidebar.exitCustomModelMode') : t('common.logout')}
          onClick={() => (customModelOnly ? exitCustomModelMode() : void api.auth.logout())}
        >
          <Icon name="logout" size={15} />
        </button>
      </div>

      {showNew && <NewSessionDialog onClose={() => setShowNew(false)} />}
      {showSearch && (
        <SearchDialog
          onClose={() => setShowSearch(false)}
          onNewChat={() => void createChatSession()}
          onOpenFolder={() => setShowNew(true)}
          onOpenSettings={() => {
            setSettingsTab('general');
            setShowSettings(true);
          }}
        />
      )}
      {showSettings && (
        <SettingsDialog initialTab={settingsTab} onClose={() => setShowSettings(false)} />
      )}
      {showFeishu && <FeishuDialog onClose={() => setShowFeishu(false)} />}

      {confirmDelete && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!deleting) setConfirmDelete(null);
          }}
        >
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                <Icon name="delete" size={17} />
                {t('sidebar.deleteTitle')}
              </h3>
              <div className="sub">
                {t('sidebar.deleteConfirm', { title: confirmDelete.title })}
              </div>
            </div>
            <div className="modal-body">
              <div className="sub">{t('sidebar.deleteWarning')}</div>
            </div>
            <div className="modal-foot">
              <button className="btn" disabled={deleting} onClick={() => setConfirmDelete(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn danger" disabled={deleting} onClick={() => void confirmDeleteNow()}>
                {deleting ? <span className="spinner" /> : <Icon name="delete" size={14} />}
                {t('sidebar.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
