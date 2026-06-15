import { useEffect, useRef, useState } from 'react';
import { useStore, type PaneKind, type SessionView as SV, type ViewDensity } from '../store';
import { ChatPane } from './panes/ChatPane';
import { DiffPane } from './panes/DiffPane';
import { FilePane, PlanPane, TasksPane, TerminalPane } from './panes/SidePanes';
import { PromptBar } from './PromptBar';
import { Icon, type IconName } from './Icon';

const PANE_META: Record<PaneKind, { icon: IconName; label: string }> = {
  chat: { icon: 'chat', label: '对话' },
  diff: { icon: 'diff', label: '改动' },
  plan: { icon: 'plan', label: '计划' },
  tasks: { icon: 'tasks', label: '任务' },
  terminal: { icon: 'terminal', label: '终端' },
  file: { icon: 'file', label: '文件' },
};

const STATUS_TEXT: Record<string, string> = {
  idle: '空闲',
  starting: '启动中',
  thinking: '思考中',
  needs_approval: '等待批准',
  error: '错误',
  exited: '已退出',
};

export function SessionView() {
  const activeId = useStore((s) => s.activeSessionId);
  const view = useStore((s) => (activeId ? s.sessions[activeId] : undefined));
  const setDensity = useStore((s) => s.setDensity);
  const togglePane = useStore((s) => s.togglePane);
  const resume = useStore((s) => s.resumeSession);
  const [viewsOpen, setViewsOpen] = useState(false);
  const viewsRef = useRef<HTMLDivElement>(null);

  // Dismiss the "视图" dropdown when clicking anywhere outside it, or on Escape.
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
            <div className="empty-title">选择左侧会话，或新建一个会话开始</div>
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
          {STATUS_TEXT[meta.status] ?? meta.status}
        </span>
        <span className="grow" />

        {dormant && (
          <button className="btn" style={{ padding: '6px 12px' }} onClick={() => void resume(meta.id)}>
            <Icon name="play" size={14} />
            恢复会话
          </button>
        )}

        <div ref={viewsRef} style={{ position: 'relative' }}>
          <button className="chip interactive" onClick={() => setViewsOpen((o) => !o)}>
            <Icon name="columns" size={14} />
            视图
          </button>
          {viewsOpen && (
            <div className="menu-pop" style={{ right: 0, top: '110%' }}>
              {(Object.keys(PANE_META) as PaneKind[]).map((p) => (
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
                  <Icon name={PANE_META[p].icon} size={14} />
                  {PANE_META[p].label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="workspace">
        {view.panes.map((p) => (
          <PaneHost key={p} kind={p} view={view} onDensity={(d) => setDensity(meta.id, d)} />
        ))}
      </div>

      <PromptBar view={view} />
    </main>
  );
}

function PaneHost({
  kind,
  view,
  onDensity,
}: {
  kind: PaneKind;
  view: SV;
  onDensity: (d: ViewDensity) => void;
}) {
  if (kind === 'chat') {
    return (
      <div className="pane">
        <div className="pane-head">
          <Icon name={PANE_META.chat.icon} size={15} />
          <span>{PANE_META.chat.label}</span>
          <span className="grow" />
          <div className="views-menu">
            {(['summary', 'normal', 'verbose'] as ViewDensity[]).map((d) => (
              <button
                key={d}
                className={view.density === d ? 'active' : ''}
                onClick={() => onDensity(d)}
                title="视图密度"
              >
                {d === 'summary' ? '摘要' : d === 'normal' ? '正常' : '详细'}
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
