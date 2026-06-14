import { useEffect, useRef, useState } from 'react';
import { useStore, type SessionView } from '../store';
import { Icon } from './Icon';
import { PERMISSION_MODES, type DirEntry, type PermissionMode } from '@shared/ipc';

const api = window.easycode;

export function PromptBar({ view }: { view: SessionView }) {
  const sendPrompt = useStore((s) => s.sendPrompt);
  const cancel = useStore((s) => s.cancel);
  const setMode = useStore((s) => s.setMode);
  const setModel = useStore((s) => s.setModel);

  const [text, setText] = useState('');
  const [atPaths, setAtPaths] = useState<Record<string, string>>({}); // name -> abs path
  const [mention, setMention] = useState<{ token: string; entries: DirEntry[]; active: number } | null>(
    null,
  );
  const taRef = useRef<HTMLTextAreaElement>(null);

  const meta = view.meta;
  const busy = meta.status === 'thinking' || meta.status === 'starting' || meta.status === 'needs_approval';

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [text]);

  const updateMention = async (value: string) => {
    const m = value.match(/@([\w./-]*)$/);
    if (!m) {
      setMention(null);
      return;
    }
    const token = m[1];
    const entries = await api.workspace.listDir(meta.cwd).catch(() => []);
    const filtered = entries
      .filter((e) => e.name.toLowerCase().includes(token.toLowerCase()))
      .slice(0, 12);
    setMention({ token, entries: filtered, active: 0 });
  };

  const onChange = (value: string) => {
    setText(value);
    void updateMention(value);
  };

  const pickMention = (entry: DirEntry) => {
    const next = text.replace(/@([\w./-]*)$/, `@${entry.name} `);
    setText(next);
    setAtPaths((p) => ({ ...p, [entry.name]: entry.path }));
    setMention(null);
    taRef.current?.focus();
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Resolve @names that match selected mentions to absolute paths.
    const used = Object.entries(atPaths)
      .filter(([name]) => trimmed.includes(`@${name}`))
      .map(([, p]) => p);
    setText('');
    setAtPaths({});
    setMention(null);
    await sendPrompt(meta.id, trimmed, used);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mention.entries.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention({ ...mention, active: (mention.active + 1) % mention.entries.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention({
          ...mention,
          active: (mention.active - 1 + mention.entries.length) % mention.entries.length,
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mention.entries[mention.active]);
        return;
      }
      if (e.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const ctxPct =
    (meta.tokenUsed ?? 0) > 0 && meta.tokenSize
      ? Math.round((meta.tokenUsed! / meta.tokenSize) * 100)
      : null;

  return (
    <div className="promptbar">
      <div className="promptbar-inner">
        <div className="prompt-config">
          <span className="chip">
            <Icon name="laptop" size={14} />
            本地
          </span>
          <span className="chip" title={meta.cwd}>
            <Icon name="folder" size={14} />
            {projectName(meta.cwd)}
          </span>
          <span className="chip">
            <Icon name="cpu" size={14} />
            <select value={meta.model ?? ''} onChange={(e) => void setModel(meta.id, e.target.value)}>
              {!meta.model && <option value="">默认模型</option>}
              {meta.availableModels.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.name}
                </option>
              ))}
            </select>
          </span>
          <span className="chip accent">
            <Icon name="shield" size={14} />
            <select
              value={meta.permissionMode}
              onChange={(e) => void setMode(meta.id, e.target.value as PermissionMode)}
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m.id} value={m.id} title={m.hint}>
                  {m.label}
                </option>
              ))}
            </select>
          </span>
          {ctxPct != null ? (
            <span className="chip" title="上下文用量">
              <span className="token-bar">
                <div style={{ width: `${Math.min(100, ctxPct)}%` }} />
              </span>
              {ctxPct}%
            </span>
          ) : null}
        </div>

        <div className="prompt-input-wrap" style={{ position: 'relative' }}>
          {mention && mention.entries.length > 0 && (
            <div className="mention-pop">
              {mention.entries.map((e, i) => (
                <div
                  key={e.path}
                  className={`mention-item ${i === mention.active ? 'active' : ''}`}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    pickMention(e);
                  }}
                >
                  <Icon name={e.isDir ? 'folder' : 'file'} size={14} />
                  <span>{e.name}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            className="prompt-input"
            rows={1}
            placeholder={busy ? '回复将在当前动作结束后被读取…（边跑边纠偏）' : '输入指令，@ 引用文件，/ 使用命令…'}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button className="btn-stop" onClick={() => void cancel(meta.id)}>
              <Icon name="stop" size={14} />
              停止
            </button>
          ) : null}
          <button className="btn-send" disabled={!text.trim()} onClick={() => void submit()}>
            <Icon name="send" size={16} />
          </button>
        </div>
        <div className="hint">Enter 发送 · Shift+Enter 换行 · 运行中输入可“边跑边纠偏”</div>
      </div>
    </div>
  );
}

function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}
