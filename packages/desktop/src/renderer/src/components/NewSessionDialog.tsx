import { useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { PERMISSION_MODES, type PermissionMode } from '@shared/ipc';

const api = window.easycode;

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const createSession = useStore((s) => s.createSession);
  const [cwd, setCwd] = useState('');
  const [mode, setMode] = useState<PermissionMode>('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async () => {
    const folder = await api.workspace.pickFolder();
    if (folder) setCwd(folder);
  };

  const start = async () => {
    if (!cwd) {
      setError('请选择项目目录');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await createSession(cwd, mode);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            <Icon name="plus" size={17} />
            新建会话
          </h3>
          <div className="sub">每个会话拥有独立的工作目录与上下文，可并行运行。</div>
        </div>
        <div className="modal-body">
          {error && (
            <div className="login-err">
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}
          <label className="field-label">环境</label>
          <div className="prompt-config">
            <span className="chip accent">
              <Icon name="laptop" size={14} />
              本地
            </span>
          </div>

          <label className="field-label">项目目录</label>
          <div className="prompt-input-wrap">
            <input
              className="prompt-input"
              style={{ height: 22 }}
              placeholder="选择一个文件夹…"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
            />
            <button className="btn" onClick={pick}>
              <Icon name="folder-open" size={14} />
              浏览…
            </button>
          </div>

          <label className="field-label">权限模式</label>
          <div className="prompt-config">
            {PERMISSION_MODES.map((m) => (
              <span
                key={m.id}
                className={`chip interactive ${mode === m.id ? 'accent' : ''}`}
                title={m.hint}
                onClick={() => setMode(m.id)}
              >
                {mode === m.id && <Icon name="check" size={13} />}
                {m.label}
              </span>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={start}>
            {busy ? <span className="spinner" /> : <Icon name="play" size={14} />}
            开始会话
          </button>
        </div>
      </div>
    </div>
  );
}
