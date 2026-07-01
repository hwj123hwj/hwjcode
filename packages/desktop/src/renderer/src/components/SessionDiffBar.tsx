import { useEffect, useMemo } from 'react';
import { useStore, type SessionView } from '../store';
import { Icon } from './Icon';
import { useT } from '../i18n/useT';

/**
 * Prompt sent to the agent when the user clicks "Commit changes". Rather than
 * shelling out to `git commit` ourselves, we hand the task to the agent so it
 * authors a sensible message and runs the commit through its normal tool flow —
 * the commit then shows up in the transcript and the pill refreshes on turn_end.
 */
const COMMIT_PROMPT = 'Commit the changes with a sensible message.';

/**
 * In-session change summary shown just above the prompt bar: a clickable
 * `+N -M` pill that opens the diff viewer, plus a "Commit changes" button that
 * asks the agent to commit.
 *
 * The stats come from the live per-project `git diff` (`view.diffs`), refreshed
 * whenever the session changes and after each turn. This is deliberately NOT the
 * old per-session `meta.added/removed` snapshot the sidebar used to show: that
 * value was captured at each session's last turn_end, so two sessions of the
 * same project drifted apart (bug). The diff is a property of the shared working
 * tree, so it belongs to the project — shown once, here, always current.
 */
export function SessionDiffBar({ view }: { view: SessionView }) {
  const refreshDiff = useStore((s) => s.refreshDiff);
  const togglePane = useStore((s) => s.togglePane);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const t = useT();

  const id = view.meta.id;
  const cwd = view.meta.cwd;

  // Keep the pill current when switching between sessions (turn_end already
  // refreshes the active one). Directory-less chats have no git tree → skip.
  useEffect(() => {
    if (cwd) void refreshDiff(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const totals = useMemo(
    () =>
      view.diffs.reduce(
        (a, d) => ({ added: a.added + d.added, removed: a.removed + d.removed }),
        { added: 0, removed: 0 },
      ),
    [view.diffs],
  );

  // Nothing to show for directory-less chats or a clean working tree.
  if (!cwd || view.diffs.length === 0) return null;

  // Mirror the prompt bar: don't fire a new prompt while the session is already
  // working (thinking / starting / awaiting approval), so the commit request
  // isn't dropped or interleaved mid-turn.
  const busy =
    view.meta.status === 'thinking' ||
    view.meta.status === 'starting' ||
    view.meta.status === 'needs_approval';

  // Toggle the full-height diff viewer: first click opens it, clicking the pill
  // again (or the viewer's own [X]) closes it and restores the chat + prompt.
  const toggleDiff = () => togglePane(id, 'diff');

  const commit = () => {
    if (busy) return;
    void sendPrompt(id, COMMIT_PROMPT, []);
  };

  return (
    <div className="session-diffbar">
      <button className="diffbar-pill" onClick={toggleDiff} title={t('diff.viewChanges')}>
        <span className="add">+{totals.added}</span>
        <span className="del">-{totals.removed}</span>
      </button>
      <button
        className="btn sm diffbar-commit-btn"
        disabled={busy}
        onClick={commit}
        title={t('diff.commitTitle')}
      >
        <Icon name="check" size={14} />
        {t('diff.commit')}
      </button>
    </div>
  );
}
