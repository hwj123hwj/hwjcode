import { useStore } from '../store';
import { Icon, toolKindIcon } from './Icon';
import { useT } from '../i18n/useT';
import { AskQuestionCard } from './AskQuestionCard';
import type { PermissionOption } from '@shared/ipc';

function btnClass(kind: PermissionOption['kind']): string {
  if (kind === 'allow_always' || kind === 'allow_once') return 'btn primary';
  if (kind === 'reject_always' || kind === 'reject_once') return 'btn danger';
  return 'btn';
}

export function PermissionDialog() {
  const queue = useStore((s) => s.permissionQueue);
  const respond = useStore((s) => s.respondPermission);
  const t = useT();
  const req = queue[0];
  if (!req) return null;

  // ask_user_question: the backend forwarded the multi-choice questions on the
  // request. Render the dedicated card instead of the plain Allow/Reject dialog.
  // Submitting picks the "allow" option (so the backend proceeds with
  // ProceedOnce) and carries the collected answers back in the response _meta.
  if (req.questions && req.questions.length > 0) {
    const allow =
      req.options.find((o) => o.kind === 'allow_once') ??
      req.options.find((o) => o.kind === 'allow_always') ??
      req.options.find((o) => o.kind !== 'reject_once' && o.kind !== 'reject_always');
    return (
      <AskQuestionCard
        questions={req.questions}
        onSubmit={(answers) =>
          void respond(req.requestId, allow?.optionId ?? null, answers)
        }
        onCancel={() => void respond(req.requestId, null)}
      />
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <h3>
            <Icon name="shield" size={17} />
            {t('permission.title')}
          </h3>
          <div className="sub">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name={toolKindIcon(req.toolKind)} size={13} />
              {req.title}
            </span>
          </div>
        </div>
        <div className="modal-body">
          {req.content?.map((c, i) => {
            if (c.diff) {
              const oldLines = (c.diff.oldText ?? '').split('\n');
              const newLines = c.diff.newText.split('\n');
              return (
                <div key={i} className="diff-preview">
                  <div className="diff-preview-head">
                    <Icon name={c.diff.oldText ? 'edit' : 'file'} size={13} />
                    {c.diff.oldText ? t('diff.edit') : t('diff.write')} {c.diff.path}
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    {c.diff.oldText
                      ? oldLines.map((l, j) => (
                          <div key={`o${j}`} className="diff-line del">
                            <span>- {l}</span>
                          </div>
                        ))
                      : null}
                    {newLines.map((l, j) => (
                      <div key={`n${j}`} className="diff-line add">
                        <span>+ {l}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }
            return c.text ? (
              <div key={i} className="console" style={{ marginBottom: 8 }}>
                {c.text}
              </div>
            ) : null;
          })}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => void respond(req.requestId, null)}>
            {t('common.cancel')}
          </button>
          {req.options.map((o) => (
            <button
              key={o.optionId}
              className={btnClass(o.kind)}
              onClick={() => void respond(req.requestId, o.optionId)}
            >
              {o.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
