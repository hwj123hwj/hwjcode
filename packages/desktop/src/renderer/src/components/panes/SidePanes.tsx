import { useStore, type SessionView } from '../../store';

/** Plan pane — the agent's current execution plan / TODO list. */
export function PlanPane({ view }: { view: SessionView }) {
  return (
    <div className="pane">
      <div className="pane-head">
        <span>📋 计划</span>
        <span className="grow" />
        <span style={{ color: 'var(--text-faint)' }}>
          {view.plan.filter((p) => p.status === 'completed').length}/{view.plan.length}
        </span>
      </div>
      <div className="pane-body">
        {view.plan.length === 0 ? (
          <div className="empty">尚无计划</div>
        ) : (
          <div className="plan-list">
            {view.plan.map((e, i) => (
              <div key={i} className={`plan-entry ${e.status}`}>
                <span className="plan-mark">
                  {e.status === 'completed' ? '✅' : e.status === 'in_progress' ? '⏳' : '⬜'}
                </span>
                <span className="plan-text">{e.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Tasks pane — in-flight + recent tool calls (the session's "background work"). */
export function TasksPane({ view }: { view: SessionView }) {
  const tools = view.transcript.filter((t) => t.kind === 'tool') as Extract<
    SessionView['transcript'][number],
    { kind: 'tool' }
  >[];
  const running = tools.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  return (
    <div className="pane">
      <div className="pane-head">
        <span>⚙️ 任务</span>
        <span className="grow" />
        <span style={{ color: 'var(--text-faint)' }}>
          {running.length} 进行中 / {tools.length} 总计
        </span>
      </div>
      <div className="pane-body">
        {tools.length === 0 ? (
          <div className="empty">暂无工具调用</div>
        ) : (
          <div className="plan-list">
            {tools
              .slice()
              .reverse()
              .map((t) => (
                <div key={t.id} className="plan-entry">
                  <span className="plan-mark">
                    {t.status === 'completed' ? '✅' : t.status === 'failed' ? '⚠️' : '⏳'}
                  </span>
                  <span className="plan-text" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {t.title}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Terminal pane — aggregated command output across the session + backend log. */
export function TerminalPane({ view }: { view: SessionView }) {
  const log = useStore((s) => s.backendLog);
  const outputs = (
    view.transcript.filter((t) => t.kind === 'tool') as Extract<
      SessionView['transcript'][number],
      { kind: 'tool' }
    >[]
  )
    .filter((t) => t.terminalOutput)
    .map((t) => `$ ${t.title}\n${t.terminalOutput}`)
    .join('\n\n');

  return (
    <div className="pane">
      <div className="pane-head">
        <span>▶_ 终端</span>
      </div>
      <div className="pane-body">
        <div className="console" style={{ margin: 12, minHeight: 120 }}>
          {outputs || '（暂无命令输出）'}
        </div>
        <div className="pane-head" style={{ borderTop: '1px solid var(--border)' }}>
          后端日志
        </div>
        <div className="console" style={{ margin: 12, color: 'var(--text-dim)' }}>
          {log.slice(-60).join('') || '（无）'}
        </div>
      </div>
    </div>
  );
}

/** File pane — read-only viewer for a file opened from a tool location. */
export function FilePane({ view }: { view: SessionView }) {
  const open = view.openFile;
  return (
    <div className="pane">
      <div className="pane-head">
        <span style={{ fontFamily: 'var(--mono)' }}>{open?.path ?? '文件'}</span>
      </div>
      <div className="pane-body">
        {open ? (
          <pre style={{ margin: 0, padding: 14, fontFamily: 'var(--mono)', fontSize: 12 }}>
            {open.content}
          </pre>
        ) : (
          <div className="empty">点击工具调用中的文件路径以查看</div>
        )}
      </div>
    </div>
  );
}
