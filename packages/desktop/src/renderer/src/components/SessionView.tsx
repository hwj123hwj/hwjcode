import { useEffect, useRef, useState } from 'react';
import { useStore, type PaneKind, type SessionView as SV } from '../store';
import { ChatPane } from './panes/ChatPane';
import { SessionTodoPanel } from './StickyTodoPanel';
import { DiffPane } from './panes/DiffPane';
import { FilePane, PlanPane, TasksPane, TerminalPane } from './panes/SidePanes';
import { PromptBar } from './PromptBar';
import { OpenWithMenu } from './OpenWithMenu';
import { WorkspaceToggles } from './workspace/WorkspaceToggles';
import { Icon, type IconName } from './Icon';
import { useT, type TFunc } from '../i18n/useT';
import { PERMISSION_MODES, type PermissionMode } from '@shared/ipc';
import { CustomSelect } from './CustomSelect';

const api = window.easycode;

/** Last path segment of a cwd, for the project chip/menu label. */
function baseName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

const PANE_ICON: Record<PaneKind, IconName> = {
  chat: 'chat',
  diff: 'diff',
  plan: 'plan',
  tasks: 'tasks',
  terminal: 'terminal',
  file: 'file',
};

export function SessionView() {
  const activeId = useStore((s) => s.activeSessionId);
  const view = useStore((s) => (activeId ? s.sessions[activeId] : undefined));
  const togglePane = useStore((s) => s.togglePane);
  const resume = useStore((s) => s.resumeSession);
  const t = useT();
  const [viewsOpen, setViewsOpen] = useState(false);
  const viewsRef = useRef<HTMLDivElement>(null);

  // Dismiss the "Views" dropdown when clicking anywhere outside it, or on Escape.
  useEffect(() => {
    if (!viewsOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!viewsRef.current?.contains(e.target as Node)) setViewsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [viewsOpen]);

  if (!view) {
    return <EmptyState />;
  }

  const meta = view.meta;
  const dormant = meta.status === 'exited';

  return (
    <main className="main">
      <div className="toolbar">
        <span className="toolbar-title">{meta.title}</span>
        <span className="toolbar-status">
          <span className={`status-dot ${meta.status}`} />
          {t(`status.${meta.status}`)}
        </span>
        <span className="grow" />

        {dormant && (
          <button className="btn" style={{ padding: '6px 12px' }} onClick={() => void resume(meta.id)}>
            <Icon name="play" size={14} />
            <span className="btn-text">{t('session.resume')}</span>
          </button>
        )}

        <OpenWithMenu cwd={meta.cwd} />

        <div ref={viewsRef} style={{ position: 'relative' }}>
          <button className="chip interactive" onClick={() => setViewsOpen((o) => !o)}>
            <Icon name="columns" size={14} />
            <span className="btn-text">{t('session.views')}</span>
          </button>
          {viewsOpen && (
            <div className="menu-pop" style={{ right: 0, top: '110%' }}>
              {(Object.keys(PANE_ICON) as PaneKind[]).map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    togglePane(meta.id, p);
                  }}
                >
                  <Icon
                    name="check"
                    size={14}
                    className={view.panes.includes(p) ? undefined : 'placeholder'}
                  />
                  <Icon name={PANE_ICON[p]} size={14} />
                  {t(`pane.${p}`)}
                </button>
              ))}
            </div>
          )}
        </div>

        <WorkspaceToggles />
      </div>

      <div className="workspace">
        {view.panes.map((p) => (
          <PaneHost key={p} kind={p} view={view} t={t} />
        ))}
      </div>

      <SessionTodoPanel key={view.meta.id} view={view} />

      <PromptBar view={view} />
    </main>
  );
}

function PaneHost({
  kind,
  view,
  t,
}: {
  kind: PaneKind;
  view: SV;
  t: TFunc;
}) {
  if (kind === 'chat') {
    // No chat header: density is fixed at 'normal' (the default) to save the
    // vertical space the old [对话 · 摘要/正常/详细] bar took.
    return (
      <div className="pane">
        <ChatPane view={view} />
      </div>
    );
  }
  if (kind === 'diff') return <DiffPane view={view} />;
  if (kind === 'plan') return <PlanPane view={view} />;
  if (kind === 'tasks') return <TasksPane view={view} />;
  if (kind === 'terminal') return <TerminalPane view={view} />;
  if (kind === 'file') return <FilePane view={view} />;
  return null;
}

/**
 * Shown when no session is active. Codex-style: a centered composer the user can
 * type into directly, with the session parameters (target project/dir and
 * permission mode) chosen up-front. On submit we mint the right kind of session
 * with those params and fire the first message — no "new session" dialog detour.
 */
function EmptyState() {
  const createChatSession = useStore((s) => s.createChatSession);
  const createSession = useStore((s) => s.createSession);
  const sendPrompt = useStore((s) => s.sendPrompt);
  // Recent project dirs, derived from existing project sessions (deduped, newest
  // first), so the user can re-enter a project without re-picking the folder.
  const order = useStore((s) => s.order);
  const sessions = useStore((s) => s.sessions);
  const t = useT();

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // null cwd → a directory-less chat; a string → a project-bound session.
  const [cwd, setCwd] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>('yolo');
  // '' → let the backend pick the default model; otherwise a modelId/custom id.
  const [model, setModel] = useState('');
  const [models, setModels] = useState<{ value: string; label: string }[]>([]);
  // Display name of the user's configured default model, when it can be resolved
  // to a name (via a prior session's availableModels or a custom model). Empty
  // string → unknown, so the picker falls back to the generic "Default model".
  const [defaultModelLabel, setDefaultModelLabel] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // Build the model picker options. We have no live session here, so the
  // built-in model list comes from the most recent existing session's
  // availableModels (cached on its meta), merged with the user's custom models.
  // customModelsRev is bumped on every save/delete so the list stays in sync.
  const customModelsRev = useStore((s) => s.customModelsRev);
  useEffect(() => {
    let alive = true;
    const builtins = new Map<string, string>();
    for (const id of order) {
      for (const m of sessions[id]?.meta.availableModels ?? []) {
        // Skip stale custom: ids cached in old sessions' availableModels
        if (m.modelId.startsWith('custom:')) continue;
        if (!builtins.has(m.modelId)) builtins.set(m.modelId, m.name);
      }
    }
    void Promise.all([
      api.models.listCustom().catch(() => [] as Awaited<ReturnType<typeof api.models.listCustom>>),
      api.settings.get().catch(() => null),
    ]).then(([custom, settings]) => {
      if (!alive) return;
      const seen = new Set<string>();
      const opts = [
        ...[...builtins].map(([value, label]) => ({ value, label })),
        ...custom
          .filter((c) => c.enabled !== false)
          .map((c) => ({ value: c.id, label: c.label })),
      ].filter(({ value }) => {
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      });
      setModels(opts);
      // Resolve the configured default model id to a display name, when we can.
      const defaultId = settings?.defaultModel?.trim();
      const label = defaultId ? opts.find((o) => o.value === defaultId)?.label : undefined;
      setDefaultModelLabel(label ?? '');
    });
    return () => {
      alive = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customModelsRev, order, sessions]);

  // Dismiss the project menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const recentProjects = (() => {
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const id of order) {
      const m = sessions[id]?.meta;
      if (!m || m.kind !== 'project') continue;
      if (seen.has(m.cwd)) continue;
      seen.add(m.cwd);
      dirs.push(m.cwd);
      if (dirs.length >= 5) break;
    }
    return dirs;
  })();

  const pickFolder = async () => {
    const folder = await api.workspace.pickFolder();
    if (folder) setCwd(folder);
    setMenuOpen(false);
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const chosenModel = model || undefined;
      const id = cwd
        ? await createSessionAndGetId(cwd, chosenModel)
        : await createChatSession(mode, undefined, chosenModel);
      await sendPrompt(id, trimmed, [], undefined);
      setText('');
    } catch {
      setBusy(false);
    }
    // On success the store sets activeSessionId, so this component unmounts.
  };

  // createSession returns void, so resolve the just-created session id from the
  // store's active id after it runs.
  const createSessionAndGetId = async (dir: string, chosenModel?: string): Promise<string> => {
    await createSession(dir, mode, undefined, chosenModel);
    const id = useStore.getState().activeSessionId;
    if (!id) throw new Error('session not created');
    return id;
  };

  const targetLabel = cwd ? baseName(cwd) : t('session.emptyChatTarget');

  return (
    <main className="main">
      {/* Draggable strip so the window can be moved from the empty/home screen,
          matching the .toolbar drag region used once a session is open. The
          workspace toggles sit at its right end (no-drag), so the bottom/right
          panels are reachable even before a session is open. */}
      <div className="empty-titlebar">
        <span className="grow" />
        <WorkspaceToggles />
      </div>
      <div className="empty">
        <div className="empty-inner">
          <div className="empty-title">{t('session.emptyPrompt')}</div>
          <div className="empty-card">
            <textarea
              ref={taRef}
              className="empty-input"
              rows={3}
              placeholder={t('session.emptyPlaceholder')}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="empty-controls">
              {/* Project / directory selector */}
              <div className="empty-target" ref={menuRef}>
                <button
                  className="chip interactive"
                  onClick={() => setMenuOpen((o) => !o)}
                  title={cwd ?? t('session.emptyChatTarget')}
                >
                  <Icon name={cwd ? 'folder' : 'chat'} size={14} />
                  {targetLabel}
                  <Icon name="chevron-down" size={12} />
                </button>
                {menuOpen && (
                  <div className="empty-menu">
                    <button
                      className="empty-menu-item"
                      onClick={() => {
                        setCwd(null);
                        setMenuOpen(false);
                      }}
                    >
                      <Icon name="chat" size={14} />
                      {t('session.emptyChatTarget')}
                    </button>
                    {recentProjects.length > 0 && (
                      <div className="empty-menu-label">{t('session.emptyRecent')}</div>
                    )}
                    {recentProjects.map((dir) => (
                      <button
                        key={dir}
                        className={`empty-menu-item ${cwd === dir ? 'active' : ''}`}
                        title={dir}
                        onClick={() => {
                          setCwd(dir);
                          setMenuOpen(false);
                        }}
                      >
                        <Icon name="folder" size={14} />
                        {baseName(dir)}
                      </button>
                    ))}
                    <div className="empty-menu-sep" />
                    <button className="empty-menu-item" onClick={() => void pickFolder()}>
                      <Icon name="folder-open" size={14} />
                      {t('session.emptyPickFolder')}
                    </button>
                  </div>
                )}
              </div>

              {/* Model selector */}
              <CustomSelect
                value={model}
                options={[
                  { value: '', label: defaultModelLabel || t('prompt.defaultModel') },
                  ...models.map((m) => ({ value: m.value, label: m.label })),
                ]}
                icon="cpu"
                onChange={(val) => setModel(val)}
              />

              {/* Permission mode */}
              <CustomSelect
                value={mode}
                options={PERMISSION_MODES.map((m) => ({
                  value: m.id,
                  label: t(`permMode.${m.id}`),
                  description: t(`permMode.${m.id}.hint`),
                }))}
                icon="shield"
                accent
                preferUp
                onChange={(val) => setMode(val as PermissionMode)}
              />

              <span className="grow" />

              <button
                className="btn primary empty-send"
                disabled={!text.trim() || busy}
                onClick={() => void submit()}
                title={t('session.emptySend')}
              >
                {busy ? <span className="spinner" /> : <Icon name="send" size={16} />}
              </button>
            </div>
          </div>
          <div className="empty-hint">{t('session.emptyHint')}</div>
        </div>
      </div>
    </main>
  );
}
