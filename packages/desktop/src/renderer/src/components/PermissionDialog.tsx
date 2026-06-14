import { useStore } from '../store';
import { Icon, toolKindIcon } from './Icon';
import type { PermissionOption } from '@shared/ipc';

function btnClass(kind: PermissionOption['kind']): string {
  if (kind === 'allow_always' || kind === 'allow_once') return 'btn primary';
  if (kind === 'reject_always' || kind === 'reject_once') return 'btn danger';
  return 'btn';
}

export function PermissionDialog() {
  const queue = useStore((s) => s.permissionQueue);
  const respond = useStore((s) => s.respondPermission);
  const req = queue[0];
  if (!req) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <h3>
            <Icon name="shield" size={17} />
            需要你的批准
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
                    {c.diff.oldText ? '编辑' : '写入'} {c.diff.path}
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
            取消
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
