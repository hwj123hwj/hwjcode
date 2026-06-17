/**
 * Sticky Todo Panel — a floating, collapsible panel pinned above the prompt bar
 * that surfaces the agent's latest task list (the `todo_write` tool). Ported from
 * the VSCode UI plugin's StickyTodoPanel so the desktop app matches it:
 *   - shows the latest todo list in real time as the agent updates it,
 *   - collapsible header with a progress bar,
 *   - robust visibility so the panel never gets "stuck" forever: it is hidden at
 *     the start of every turn, only re-appears when the agent emits a *changed*
 *     list this turn, and auto-collapses when the agent finishes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem, SessionView } from '../store';
import { Icon } from './Icon';
import { useT } from '../i18n/useT';

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

interface TodoData {
  title?: string;
  items: TodoItem[];
}

// Display order matches the VSCode plugin / core `todo_write` returnDisplay:
// completed first, then in-progress, then pending.
const STATUS_RANK: Record<TodoStatus, number> = {
  completed: 0,
  cancelled: 0,
  in_progress: 1,
  pending: 2,
};

/**
 * Scan the transcript newest→oldest for the most recent `todo_write` tool call
 * and return its task list. We read the tool's `rawInput.todos` (the desktop
 * already captures it on the tool item), which carries the full list. Returns
 * null when there is no todo call yet.
 */
function extractLatestTodos(transcript: ChatItem[]): TodoData | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i];
    if (item.kind !== 'tool') continue;
    const todos = item.rawInput?.todos;
    if (!Array.isArray(todos) || todos.length === 0) continue;
    const items: TodoItem[] = todos
      .map((t) => {
        const raw = t as Record<string, unknown>;
        return {
          id: String(raw.id ?? ''),
          content: String(raw.content ?? ''),
          status: (raw.status as TodoStatus) ?? 'pending',
        };
      })
      .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));
    return { items };
  }
  return null;
}

const StatusCheckbox = ({ status }: { status: TodoStatus }) => (
  <div className={`todo-checkbox ${status}`}>
    {status === 'completed' && (
      <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
        <path d="M2 5L4 7L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )}
    {status === 'in_progress' && <div className="todo-checkbox-dot" />}
    {status === 'cancelled' && (
      <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
        <path d="M3 3L7 7M7 3L3 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )}
  </div>
);

function TodoPanel({
  data,
  collapsed,
  onToggle,
  title,
}: {
  data: TodoData;
  collapsed: boolean;
  onToggle: () => void;
  title: string;
}) {
  const items = data.items;
  const done = items.filter((i) => i.status === 'completed' || i.status === 'cancelled').length;
  const total = items.length;
  const progress = total > 0 ? (done / total) * 100 : 0;

  if (total === 0) return null;

  return (
    <div className={`sticky-todo-panel ${collapsed ? 'collapsed' : 'expanded'}`}>
      <div className="sticky-todo-header" onClick={onToggle}>
        <div className="sticky-todo-head-left">
          <Icon name="tasks" size={14} className="sticky-todo-icon" />
          <span className="sticky-todo-title">{data.title || title}</span>
          <span className="sticky-todo-count">
            ({done}/{total})
          </span>
        </div>
        <div className="sticky-todo-head-right">
          <div className="sticky-todo-bar">
            <div className="sticky-todo-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <Icon name="chevron-down" size={14} className={`sticky-todo-chevron ${collapsed ? 'up' : ''}`} />
        </div>
      </div>

      {!collapsed && (
        <div className="sticky-todo-content">
          {items.map((item) => (
            <div key={item.id} className={`todo-item-row ${item.status}`}>
              <StatusCheckbox status={item.status} />
              <span className={`todo-item-text ${item.status}`}>{item.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Stateful host that wires the panel to a session. Mount this with
 * `key={view.meta.id}` so each session gets its own fresh visibility state.
 */
export function SessionTodoPanel({ view }: { view: SessionView }) {
  const t = useT();
  const status = view.meta.status;
  // The agent is mid-turn while thinking/starting, and also while a permission
  // request is pending (the turn hasn't ended) — treat all three as "active" so
  // we don't hide/collapse the panel in the middle of a turn.
  const active = status === 'thinking' || status === 'starting' || status === 'needs_approval';

  const latestTodos = useMemo(() => extractLatestTodos(view.transcript), [view.transcript]);

  const [visible, setVisible] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const prevActiveRef = useRef(false);
  // Snapshot of the todo list at the start of the current turn. The panel only
  // re-appears when the agent emits a list that differs from this baseline, so a
  // leftover (unchanged) list from a previous turn never re-shows — this is the
  // core "never gets stuck" guard.
  const turnStartSigRef = useRef('');

  // Turn boundary, driven by the active→idle / idle→active edges.
  useEffect(() => {
    const rising = active && !prevActiveRef.current;
    const falling = !active && prevActiveRef.current;
    if (rising) {
      // New turn: hide the previous turn's panel and record the baseline.
      setVisible(false);
      turnStartSigRef.current = latestTodos ? JSON.stringify(latestTodos.items) : '';
    } else if (falling && visible) {
      // Turn finished: collapse (but keep it available) rather than yank it away.
      setCollapsed(true);
    }
    prevActiveRef.current = active;
    // Intentionally keyed on `active` only — this is an edge detector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Show the panel when the agent emits a genuinely new list during this turn.
  useEffect(() => {
    if (latestTodos && active) {
      const sig = JSON.stringify(latestTodos.items);
      if (sig !== turnStartSigRef.current) {
        setVisible(true);
        setCollapsed(false);
      }
    }
  }, [latestTodos, active]);

  if (!latestTodos || !visible) return null;

  return (
    <TodoPanel
      data={latestTodos}
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
      title={t('todo.title')}
    />
  );
}
