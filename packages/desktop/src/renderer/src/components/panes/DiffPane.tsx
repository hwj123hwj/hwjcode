import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore, type SessionView } from '../../store';
import { Icon } from '../Icon';
import { useT, type TFunc } from '../../i18n/useT';
import type { GitFileDiff } from '@shared/ipc';

const api = window.easycode;

/** One inline review comment, anchored to a specific rendered diff row. */
interface Comment {
  file: string;
  /** Unique per-file row key (`type:old:new`) so a del and an add on the same
   *  numeric line don't collide. */
  anchor: string;
  /** Human line number (new side, or old for deletions) — used in the prompt. */
  line: number;
  body: string;
}

/** Last path segment — headers show the file name, not its path. */
function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// ── unified-diff parsing ────────────────────────────────────────────────────
type LineType = 'ctx' | 'add' | 'del';
interface DLine { type: LineType; oldNo?: number; newNo?: number; text: string }
interface Hunk { oldStart: number; oldLen: number; newStart: number; newLen: number; lines: DLine[] }

const SIGN: Record<LineType, string> = { add: '+', del: '-', ctx: ' ' };

/** Unchanged gaps of at most this many lines are shown inline (once the file is
 *  loaded); only longer runs collapse behind an "Expand N unchanged lines" link,
 *  so we never render a pointless "Expand 1 line" fold. */
const GAP_FOLD_MIN = 4;

/**
 * Parse a `git diff` patch into hunks with per-line old/new line numbers. The
 * `diff --git` / `index` / `---` / `+++` preamble is skipped. Untracked files
 * carry no `@@` hunks (their patch is all `+` lines), so we synthesise a single
 * all-added hunk for them.
 */
function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!m) { cur = null; continue; }
      cur = {
        oldStart: +m[1], oldLen: m[2] ? +m[2] : 1,
        newStart: +m[3], newLen: m[4] ? +m[4] : 1,
        lines: [],
      };
      hunks.push(cur);
      oldNo = cur.oldStart;
      newNo = cur.newStart;
      continue;
    }
    if (!cur) continue; // preamble before the first hunk
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      cur.lines.push({ type: 'add', newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      cur.lines.push({ type: 'del', oldNo: oldNo++, text: raw.slice(1) });
    } else if (raw.startsWith('\\')) {
      /* "\ No newline at end of file" — ignore */
    } else {
      // context line (leading space) or a blank line inside the hunk
      cur.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: raw.startsWith(' ') ? raw.slice(1) : raw });
    }
  }

  // Untracked / added-with-no-hunk fallback: treat every `+` line as added.
  if (hunks.length === 0) {
    const adds = patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l, i): DLine => ({ type: 'add', newNo: i + 1, text: l.slice(1) }));
    if (adds.length) hunks.push({ oldStart: 0, oldLen: 0, newStart: 1, newLen: adds.length, lines: adds });
  }
  return hunks;
}

/** An unchanged region between/around hunks that isn't present in the patch. */
interface Gap { newFrom: number; newTo: number; oldFrom: number; oldTo: number }

function computeGap(prev: Hunk | null, next: Hunk | null, totalNew: number | null): Gap | null {
  if (!prev && next) {
    // leading: lines 1 .. firstHunk.start-1
    const newTo = next.newStart - 1;
    if (newTo < 1) return null;
    return { newFrom: 1, newTo, oldFrom: 1, oldTo: next.oldStart - 1 };
  }
  if (prev && !next) {
    // trailing: needs the file length to know where it ends
    if (totalNew == null) return null;
    const newFrom = prev.newStart + prev.newLen;
    if (newFrom > totalNew) return null;
    const oldFrom = prev.oldStart + prev.oldLen;
    return { newFrom, newTo: totalNew, oldFrom, oldTo: oldFrom + (totalNew - newFrom) };
  }
  if (prev && next) {
    const newFrom = prev.newStart + prev.newLen;
    const newTo = next.newStart - 1;
    if (newTo < newFrom) return null;
    return { newFrom, newTo, oldFrom: prev.oldStart + prev.oldLen, oldTo: next.oldStart - 1 };
  }
  return null;
}

export function DiffPane({ view }: { view: SessionView }) {
  const refreshDiff = useStore((s) => s.refreshDiff);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const togglePane = useStore((s) => s.togglePane);
  const t = useT();
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState<{ file: string; anchor: string; line: number } | null>(null);
  const [draftBody, setDraftBody] = useState('');

  useEffect(() => {
    void refreshDiff(view.meta.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.meta.id]);

  const diffs = view.diffs;

  const pickLine = (file: string, anchor: string, line: number) => {
    setDraft({ file, anchor, line });
    setDraftBody('');
  };
  const addComment = () => {
    if (!draft || !draftBody.trim()) return;
    setComments((c) => [...c, { file: draft.file, anchor: draft.anchor, line: draft.line, body: draftBody.trim() }]);
    setDraft(null);
    setDraftBody('');
  };

  const submitReview = async () => {
    if (comments.length === 0) return;
    const text =
      t('diff.reviewPrompt') +
      comments.map((c) => `- ${c.file}:${c.line} — ${c.body}`).join('\n');
    await sendPrompt(view.meta.id, text, []);
    setComments([]);
  };

  const reviewSelf = async () => {
    await sendPrompt(view.meta.id, t('diff.selfReviewPrompt'), []);
  };

  const sum = totals(diffs);

  return (
    <div className="pane diff-pane">
      <div className="pane-head">
        <Icon name="diff" size={15} />
        <span>{t('pane.diff')}</span>
        <span className="diff-chip">
          <span className="add">+{sum.added}</span>
          <span className="del">-{sum.removed}</span>
        </span>
        <span className="grow" />
        <button className="icon-btn" title={t('common.refresh')} onClick={() => void refreshDiff(view.meta.id)}>
          <Icon name="refresh" size={15} />
        </button>
        <button className="icon-btn" title={t('diff.selfReviewTitle')} onClick={reviewSelf}>
          <Icon name="review" size={15} />
        </button>
        {comments.length > 0 && (
          <button className="btn primary" style={{ padding: '5px 11px' }} onClick={submitReview}>
            <Icon name="comment" size={14} />
            {t('diff.submitComments', { n: comments.length })}
          </button>
        )}
        {/* Close the diff viewer — removes the 'diff' pane, restoring the chat +
            prompt layout (see SessionView's full-height diff handling). */}
        <button className="icon-btn" title={t('common.close')} onClick={() => togglePane(view.meta.id, 'diff')}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="diff-view">
        {diffs.length === 0 ? (
          <div className="group-label" style={{ padding: 16 }}>{t('diff.noChanges')}</div>
        ) : (
          diffs.map((d) => (
            <FileDiff
              key={d.path}
              diff={d}
              cwd={view.meta.cwd}
              t={t}
              comments={comments.filter((c) => c.file === d.path)}
              draft={draft?.file === d.path ? draft : null}
              draftBody={draftBody}
              onPick={(anchor, line) => pickLine(d.path, anchor, line)}
              onDraftChange={setDraftBody}
              onAdd={addComment}
            />
          ))
        )}
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

/**
 * One file's diff: a sticky, click-to-collapse header (file name only + stats)
 * over the hunks. Unchanged regions between/around hunks render as "Expand N
 * unchanged lines" bars; clicking one reveals the real lines, read from the file
 * on disk (the current file matches the new/context side of the diff).
 */
function FileDiff({
  diff, cwd, t, comments, draft, draftBody, onPick, onDraftChange, onAdd,
}: {
  diff: GitFileDiff;
  cwd: string;
  t: TFunc;
  comments: Comment[];
  draft: { anchor: string } | null;
  draftBody: string;
  onPick: (anchor: string, line: number) => void;
  onDraftChange: (s: string) => void;
  onAdd: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [fileLines, setFileLines] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const hunks = useMemo(() => parseHunks(diff.patch), [diff.patch]);
  // Deleted files have no new content; untracked files are fully in the patch.
  const needsFile = diff.status !== 'deleted' && diff.status !== 'untracked';

  useEffect(() => {
    if (collapsed || !needsFile || fileLines) return;
    let alive = true;
    const abs = cwd.replace(/[\\/]+$/, '') + '/' + diff.path;
    void api.workspace.readFile(abs).then(
      (c) => { if (alive) setFileLines(c.split('\n')); },
      () => { /* binary / unreadable — expansion just stays unavailable */ },
    );
    return () => { alive = false; };
  }, [collapsed, needsFile, fileLines, cwd, diff.path]);

  const totalNew = fileLines ? fileLines.length : null;

  const renderLine = (
    key: string, type: LineType, oldNo: number | undefined, newNo: number | undefined, text: string,
  ): ReactNode => {
    const anchor = `${type}:${oldNo ?? ''}:${newNo ?? ''}`;
    const gut = type === 'del' ? oldNo : newNo;
    const lineNo = newNo ?? oldNo ?? 0;
    const rowComments = comments.filter((c) => c.anchor === anchor);
    const showDraft = draft?.anchor === anchor;
    return (
      <div key={key}>
        <div
          className={`diff-line ${type}`}
          onClick={() => onPick(anchor, lineNo)}
          title={t('diff.addCommentTitle')}
          style={{ cursor: 'pointer' }}
        >
          <span className="diff-gutter">{gut ?? ''}</span>
          <span className="diff-code">{SIGN[type]}{text}</span>
        </div>
        {rowComments.map((c, ci) => (
          <div key={`c${ci}`} className="diff-comment-row">
            <Icon name="comment" size={14} />
            {c.body}
          </div>
        ))}
        {showDraft && (
          <div className="diff-comment-row">
            <textarea
              autoFocus
              rows={2}
              placeholder={t('diff.commentPlaceholder')}
              value={draftBody}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onAdd(); }
              }}
            />
          </div>
        )}
      </div>
    );
  };

  const body: ReactNode[] = [];
  const pushGap = (prev: Hunk | null, next: Hunk | null) => {
    const gap = computeGap(prev, next, totalNew);
    if (!gap) return;
    const count = gap.newTo - gap.newFrom + 1;
    if (count <= 0) return;
    const gid = gap.newFrom;
    // Short runs are shown inline (no fold); longer runs collapse until clicked.
    // Both need the file loaded to reveal the actual lines; until then, fall back
    // to the fold link so no region silently disappears.
    const showInline = fileLines != null && (count <= GAP_FOLD_MIN || expanded.has(gid));
    if (showInline && fileLines) {
      for (let n = gap.newFrom; n <= gap.newTo; n++) {
        const oldN = gap.oldFrom + (n - gap.newFrom);
        body.push(renderLine(`g${gid}-${n}`, 'ctx', oldN, n, fileLines[n - 1] ?? ''));
      }
    } else {
      body.push(
        <button
          key={`gap${gid}`}
          className="diff-gap"
          onClick={() => setExpanded((s) => new Set(s).add(gid))}
        >
          <Icon name="chevron-down" size={14} />
          {t('diff.expandLines', { n: count })}
        </button>,
      );
    }
  };

  if (!collapsed) {
    pushGap(null, hunks[0] ?? null);
    hunks.forEach((h, i) => {
      h.lines.forEach((l, li) => body.push(renderLine(`h${i}-${li}`, l.type, l.oldNo, l.newNo, l.text)));
      pushGap(h, hunks[i + 1] ?? null);
    });
  }

  return (
    <div className="diff-file-section">
      <div className="diff-file-head" onClick={() => setCollapsed((c) => !c)} title={t('diff.toggleFile')}>
        <span className="diff-file-chevron">
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
        </span>
        <span className="diff-file-name" title={diff.path}>{baseName(diff.path)}</span>
        <span className="diff-chip">
          <span className="add">+{diff.added}</span> <span className="del">-{diff.removed}</span>
        </span>
      </div>
      {!collapsed && <div className="diff-file-body">{body}</div>}
    </div>
  );
}
