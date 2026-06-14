import { useState } from 'react';
import { useStore, type PaneKind, type SessionView as SV, type ViewDensity } from '../store';
import { ChatPane } from './panes/ChatPane';
import { DiffPane } from './panes/DiffPane';
import { FilePane, PlanPane, TasksPane, TerminalPane } from './panes/SidePanes';
import { PromptBar } from './PromptBar';

const PANE_LABELS: Record<PaneKind, string> = {
  chat: '💬 对话',
  diff: '± 改动',
  plan: '📋 计划',
  tasks: '⚙️ 任务',
  terminal: '▶_ 终端',
  file: '📄 文件',
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

  if (!view) {
    return (
      <main className="main">
        <div className="empty">
          <div>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✦</div>
            选择左侧会话，或新建一个会话开始
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
        <span className="status-dot" style={{ position: 'static' }} />
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          {STATUS_TEXT[meta.status] ?? meta.status}
        </span>
        <span className="grow" />

        {dormant && (
          <button className="btn" style={{ padding: '4px 10px' }} onClick={() => void resume(meta.id)}>
            ▶ 恢复会话
          </button>
        )}

        <div style={{ position: 'relative' }}>
          <button className="chip" onClick={() => setViewsOpen((o) => !o)}>
            ⊞ 视图
          </button>
          {viewsOpen && (
            <div className="menu-pop" style={{ right: 0, top: '110%' }}>
              {(Object.keys(PANE_LABELS) as PaneKind[]).map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    togglePane(meta.id, p);
                  }}
                >
                  {view.panes.includes(p) ? '✓ ' : '　'}
                  {PANE_LABELS[p]}
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
          <span>{PANE_LABELS.chat}</span>
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
