/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * AskQuestionCard — the desktop renderer for the `ask_user_question` tool.
 *
 * The backend forwards the multi-choice questions out-of-band on the permission
 * request (`PermissionRequest.questions`); this card collects the user's
 * selections and returns them via `respondPermission(requestId, optionId,
 * answers)`, which travels back to the backend in the ACP response `_meta`.
 *
 * Mirrors the CLI's AskUserQuestionMessage semantics (single/multi select,
 * "Other" free-text, side-by-side preview) but with a mouse-driven UI.
 */

import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n/useT';
import type { AskAnswersPayload, AskQuestion } from '@shared/ipc';

interface Props {
  /** The questions to render (req.questions, narrowed by the caller). */
  questions: AskQuestion[];
  /** Resolve the permission with the chosen allow option + collected answers. */
  onSubmit: (answers: AskAnswersPayload) => void;
  /** Cancel the prompt (maps to ToolConfirmationOutcome.Cancel on the backend). */
  onCancel: () => void;
}

/** Per-question working state: selected labels + free-text "Other" input. */
interface QState {
  selected: string[];
  otherActive: boolean;
  otherText: string;
}

export function AskQuestionCard({ questions, onSubmit, onCancel }: Props) {
  const t = useT();
  const [states, setStates] = useState<Record<string, QState>>(() => {
    const init: Record<string, QState> = {};
    for (const q of questions) {
      init[q.question] = { selected: [], otherActive: false, otherText: '' };
    }
    return init;
  });

  const patch = (q: string, p: Partial<QState>) =>
    setStates((s) => ({ ...s, [q]: { ...s[q], ...p } }));

  const toggle = (q: AskQuestion, label: string) => {
    const cur = states[q.question];
    if (q.multiSelect) {
      const has = cur.selected.includes(label);
      patch(q.question, {
        selected: has
          ? cur.selected.filter((l) => l !== label)
          : [...cur.selected, label],
      });
    } else {
      // single-select: picking a concrete option clears the "Other" input.
      patch(q.question, { selected: [label], otherActive: false, otherText: '' });
    }
  };

  const pickOther = (q: AskQuestion) => {
    if (q.multiSelect) {
      patch(q.question, { otherActive: !states[q.question].otherActive });
    } else {
      patch(q.question, { selected: [], otherActive: true });
    }
  };

  /** Resolve a question's final answer string (selected labels + "Other" text). */
  const answerFor = (q: AskQuestion): string => {
    const st = states[q.question];
    const parts = [...st.selected];
    if (st.otherActive && st.otherText.trim()) parts.push(st.otherText.trim());
    return parts.join(', ');
  };

  const allAnswered = useMemo(
    () => questions.every((q) => answerFor(q).length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [states, questions],
  );

  const submit = () => {
    const answers: Record<string, string> = {};
    const annotations: AskAnswersPayload['annotations'] = {};
    for (const q of questions) {
      const a = answerFor(q);
      if (!a) continue;
      answers[q.question] = a;
      // Carry the preview of the selected option + free-text notes, mirroring
      // the CLI's annotation payload (single-select only).
      if (!q.multiSelect) {
        const sel = states[q.question].selected[0];
        const previewOpt = sel ? q.options.find((o) => o.label === sel) : undefined;
        const notes = states[q.question].otherText.trim();
        if (previewOpt?.preview || notes) {
          annotations[q.question] = {
            ...(previewOpt?.preview ? { preview: previewOpt.preview } : {}),
            ...(notes ? { notes } : {}),
          };
        }
      }
    }
    onSubmit({
      answers,
      ...(Object.keys(annotations).length ? { annotations } : {}),
    });
  };

  return (
    <div className="modal-backdrop">
      <div className="modal ask-card">
        <div className="modal-head">
          <h3>
            <Icon name="comment" size={17} />
            {t('ask.title')}
          </h3>
        </div>
        <div className="modal-body">
          {questions.map((q) => {
            const st = states[q.question];
            const preview =
              !q.multiSelect && st.selected[0]
                ? q.options.find((o) => o.label === st.selected[0])?.preview
                : undefined;
            return (
              <div key={q.question} className="ask-question">
                <div className="ask-q-head">
                  <span className="ask-q-chip">{q.header}</span>
                  <span className="ask-q-text">{q.question}</span>
                  {q.multiSelect ? (
                    <span className="ask-q-hint">· {t('ask.multiHint')}</span>
                  ) : null}
                </div>
                <div className={preview ? 'ask-q-split' : undefined}>
                  <div className="ask-options">
                    {q.options.map((o) => {
                      const active = st.selected.includes(o.label);
                      return (
                        <button
                          key={o.label}
                          className={`ask-option${active ? ' active' : ''}`}
                          onClick={() => toggle(q, o.label)}
                        >
                          <span className="ask-option-mark">
                            {active ? (q.multiSelect ? '☑' : '◉') : q.multiSelect ? '☐' : '○'}
                          </span>
                          <span className="ask-option-body">
                            <span className="ask-option-label">{o.label}</span>
                            {o.description ? (
                              <span className="ask-option-desc">{o.description}</span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      className={`ask-option${st.otherActive ? ' active' : ''}`}
                      onClick={() => pickOther(q)}
                    >
                      <span className="ask-option-mark">
                        {st.otherActive ? (q.multiSelect ? '☑' : '◉') : q.multiSelect ? '☐' : '○'}
                      </span>
                      <span className="ask-option-body">
                        <span className="ask-option-label">{t('ask.other')}</span>
                      </span>
                    </button>
                    {st.otherActive ? (
                      <input
                        className="ask-other-input"
                        autoFocus
                        value={st.otherText}
                        placeholder={t('ask.otherPlaceholder')}
                        onChange={(e) => patch(q.question, { otherText: e.target.value })}
                      />
                    ) : null}
                  </div>
                  {preview ? (
                    <pre className="ask-preview">{preview}</pre>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>
            {t('ask.skip')}
          </button>
          <button className="btn primary" disabled={!allAnswered} onClick={submit}>
            {t('ask.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
