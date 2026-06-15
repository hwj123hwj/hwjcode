import { useEffect, useRef, useState } from 'react';
import { useStore, type PaneKind, type SessionView as SV, type ViewDensity } from '../store';
import { ChatPane } from './panes/ChatPane';
import { DiffPane } from './panes/DiffPane';
import { FilePane, PlanPane, TasksPane, TerminalPane } from './panes/SidePanes';
import { PromptBar } from './PromptBar';
import { Icon, type IconName } from './Icon';
import { useT, type TFunc } from '../i18n/useT';

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
  const setDensity = useStore((s) => s.setDensity);
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
    return (
      <main className="main">
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-mark">
              <Icon name="sparkle" size={24} />
            </span>
            <div className="empty-title">{t('session.emptyTitle')}</div>
          </div>
        </div>
      </main>
    );
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
            {t('session.resume')}
          </button>
        )}

        <div ref={viewsRef} style={{ position: 'relative' }}>
          <button className="chip interactive" onClick={() => setViewsOpen((o) => !o)}>
            <Icon name="columns" size={14} />
            {t('session.views')}
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
      </div>

      <div className="workspace">
        {view.panes.map((p) => (
          <PaneHost key={p} kind={p} view={view} t={t} onDensity={(d) => setDensity(meta.id, d)} />
        ))}
      </div>

      <PromptBar view={view} />
    </main>
  );
}

function PaneHost({
  kind,
  view,
  t,
  onDensity,
}: {
  kind: PaneKind;
  view: SV;
  t: TFunc;
  onDensity: (d: ViewDensity) => void;
}) {
  if (kind === 'chat') {
    return (
      <div className="pane">
        <div className="pane-head">
          <Icon name={PANE_ICON.chat} size={15} />
          <span>{t('pane.chat')}</span>
          <span className="grow" />
          <div className="views-menu">
            {(['summary', 'normal', 'verbose'] as ViewDensity[]).map((d) => (
              <button
                key={d}
                className={view.density === d ? 'active' : ''}
                onClick={() => onDensity(d)}
                title={t('density.title')}
              >
                {t(`density.${d}`)}
              </button>
            ))}
          </div>
        </div>
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
