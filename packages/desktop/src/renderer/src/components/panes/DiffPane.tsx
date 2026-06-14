import { useEffect, useMemo, useState } from 'react';
import { useStore, type SessionView } from '../../store';
import { Icon } from '../Icon';
import type { GitFileDiff } from '@shared/ipc';

interface Comment {
  file: string;
  line: number;
  body: string;
}

export function DiffPane({ view }: { view: SessionView }) {
  const refreshDiff = useStore((s) => s.refreshDiff);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draftLine, setDraftLine] = useState<number | null>(null);
  const [draftBody, setDraftBody] = useState('');

  useEffect(() => {
    void refreshDiff(view.meta.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.meta.id]);

  const diffs = view.diffs;
  const current = useMemo(
    () => diffs.find((d) => d.path === activeFile) ?? diffs[0],
    [diffs, activeFile],
  );

  const addComment = () => {
    if (draftLine == null || !draftBody.trim() || !current) return;
    setComments((c) => [...c, { file: current.path, line: draftLine, body: draftBody.trim() }]);
    setDraftLine(null);
    setDraftBody('');
  };

  const submitReview = async () => {
    if (comments.length === 0) return;
    const text =
      '请处理以下针对当前改动的代码评审意见：\n\n' +
      comments.map((c) => `- ${c.file}:${c.line} — ${c.body}`).join('\n');
    await sendPrompt(view.meta.id, text, []);
    setComments([]);
  };

  const reviewSelf = async () => {
    await sendPrompt(
      view.meta.id,
      '请自审当前未提交的改动，找出编译错误、逻辑错误、安全问题或明显 bug（忽略风格/lint），并直接修复。',
      [],
    );
  };

  return (
    <div className="pane">
      <div className="pane-head">
        <Icon name="diff" size={15} />
        <span>改动</span>
        <span className="diff-chip">
          <span className="add">+{totals(diffs).added}</span>
          <span className="del">-{totals(diffs).removed}</span>
        </span>
        <span className="grow" />
        <button className="icon-btn" title="刷新" onClick={() => void refreshDiff(view.meta.id)}>
          <Icon name="refresh" size={15} />
        </button>
        <button className="icon-btn" title="自审改动" onClick={reviewSelf}>
          <Icon name="review" size={15} />
        </button>
        {comments.length > 0 && (
          <button className="btn primary" style={{ padding: '5px 11px' }} onClick={submitReview}>
            <Icon name="comment" size={14} />
            提交 {comments.length} 条评论
          </button>
        )}
      </div>
      <div className="diff-layout">
        <div className="diff-files">
          {diffs.length === 0 && <div className="group-label">无未提交改动</div>}
          {diffs.map((d) => (
            <div
              key={d.path}
              className={`diff-file ${current?.path === d.path ? 'active' : ''}`}
              onClick={() => setActiveFile(d.path)}
            >
              <Icon name="file" size={14} />
              <span className="name" title={d.path}>
                {d.path}
              </span>
              <span className="diff-chip">
                <span className="add">+{d.added}</span>
                <span className="del">-{d.removed}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="diff-view">
          {current ? (
            <DiffBody
              diff={current}
              comments={comments.filter((c) => c.file === current.path)}
              draftLine={draftLine}
              draftBody={draftBody}
              onPickLine={(n) => {
                setDraftLine(n);
                setDraftBody('');
              }}
              onDraftChange={setDraftBody}
              onAdd={addComment}
            />
          ) : (
            <div className="empty">选择一个文件查看 diff</div>
          )}
        </div>
      </div>
    </div>
  );
}

function totals(diffs: GitFileDiff[]) {
  return diffs.reduce(
    (a, d) => ({ added: a.added + d.added, removed: a.removed + d.removed }),
    { added: 0, removed: 0 },
  );
}

function DiffBody({
  diff,
  comments,
  draftLine,
  draftBody,
  onPickLine,
  onDraftChange,
  onAdd,
}: {
  diff: GitFileDiff;
  comments: Comment[];
  draftLine: number | null;
  draftBody: string;
  onPickLine: (n: number) => void;
  onDraftChange: (s: string) => void;
  onAdd: () => void;
}) {
  const lines = diff.patch.split('\n');
  return (
    <div>
      {lines.map((line, i) => {
        const cls = line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+') && !line.startsWith('+++')
            ? 'add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'del'
              : '';
        const lineComments = comments.filter((c) => c.line === i);
        return (
          <div key={i}>
            <div
              className={`diff-line ${cls}`}
              onClick={() => onPickLine(i)}
              style={{ cursor: 'pointer' }}
              title="点击行添加评论"
            >
              <span className="diff-gutter">{i}</span>
              <span>{line || ' '}</span>
            </div>
            {lineComments.map((c, ci) => (
              <div key={ci} className="diff-comment-row">
                <Icon name="comment" size={14} />
                {c.body}
              </div>
            ))}
            {draftLine === i && (
              <div className="diff-comment-row">
                <textarea
                  autoFocus
                  rows={2}
                  placeholder="写下评审意见，回车提交…"
                  value={draftBody}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      onAdd();
                    }
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
