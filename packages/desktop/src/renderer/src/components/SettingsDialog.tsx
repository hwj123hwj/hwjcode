import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import type {
  CustomModelEntry,
  CustomModelInput,
  CustomModelProvider,
} from '@shared/ipc';

const api = window.easycode;

const PROVIDERS: { id: CustomModelProvider; label: string }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'gemini', label: 'Gemini' },
];

const EMPTY_FORM: CustomModelInput = {
  displayName: '',
  provider: 'openai',
  baseUrl: '',
  apiKey: '',
  modelId: '',
  maxTokens: undefined,
  enabled: true,
};

/**
 * Settings — custom model management. Reads/writes the shared
 * `~/.easycode-user/custom-models.json` (the same store the CLI uses), so
 * models added here are picked up by every newly created session's ACP
 * backend.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [models, setModels] = useState<CustomModelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<CustomModelInput | null>(null);
  /** displayName of the model being edited (undefined when adding). */
  const [editingName, setEditingName] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    const list = await api.models.listCustom();
    setModels(list);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startAdd = () => {
    setError('');
    setEditingName(undefined);
    setForm({ ...EMPTY_FORM });
  };

  const startEdit = (m: CustomModelEntry) => {
    setError('');
    setEditingName(m.displayName);
    setForm({
      displayName: m.displayName,
      provider: m.provider,
      baseUrl: m.baseUrl,
      apiKey: m.apiKey,
      modelId: m.modelId,
      maxTokens: m.maxTokens,
      enabled: m.enabled !== false,
    });
  };

  const remove = async (m: CustomModelEntry) => {
    await api.models.deleteCustom(m.displayName);
    await refresh();
  };

  const save = async () => {
    if (!form) return;
    if (!form.displayName.trim()) return setError('请填写名称');
    if (!form.baseUrl.trim()) return setError('请填写 Base URL');
    if (!form.apiKey.trim()) return setError('请填写 API Key');
    if (!form.modelId.trim()) return setError('请填写模型 ID');
    setBusy(true);
    setError('');
    const res = await api.models.saveCustom(form, editingName);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? '保存失败');
      return;
    }
    setForm(null);
    setEditingName(undefined);
    await refresh();
  };

  const patch = (p: Partial<CustomModelInput>) =>
    setForm((f) => (f ? { ...f, ...p } : f));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            <Icon name="settings" size={17} />
            设置 · 自定义模型
          </h3>
          <div className="sub">
            自定义模型与 CLI 共用 <code>~/.easycode-user/custom-models.json</code>
            。新增或修改后，将在下次新建会话时生效。
          </div>
        </div>

        <div className="modal-body">
          {error && (
            <div className="login-err">
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}

          {!form && (
            <>
              <div className="cm-list">
                {loading && (
                  <div className="cm-empty">
                    <span className="spinner" /> 加载中…
                  </div>
                )}
                {!loading && models.length === 0 && (
                  <div className="cm-empty">还没有自定义模型</div>
                )}
                {models.map((m) => (
                  <div className="cm-row" key={m.id}>
                    <div className="cm-row-main">
                      <span className="cm-name">{m.displayName}</span>
                      <span className="cm-badge">
                        {PROVIDERS.find((p) => p.id === m.provider)?.label ?? m.provider}
                      </span>
                      {m.enabled === false && <span className="cm-badge muted">已禁用</span>}
                    </div>
                    <div className="cm-row-sub">
                      {m.modelId} · {m.baseUrl}
                    </div>
                    <div className="cm-actions">
                      <button className="icon-btn" title="编辑" onClick={() => startEdit(m)}>
                        <Icon name="edit" size={14} />
                      </button>
                      <button className="icon-btn" title="删除" onClick={() => void remove(m)}>
                        <Icon name="delete" size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn" onClick={startAdd}>
                <Icon name="plus" size={14} />
                添加自定义模型
              </button>
            </>
          )}

          {form && (
            <div className="cm-form">
              <label className="field-label">名称</label>
              <input
                className="prompt-input cm-input"
                placeholder="例如 My GPT-4o"
                value={form.displayName}
                onChange={(e) => patch({ displayName: e.target.value })}
              />

              <label className="field-label">协议</label>
              <div className="prompt-config">
                {PROVIDERS.map((p) => (
                  <span
                    key={p.id}
                    className={`chip interactive ${form.provider === p.id ? 'accent' : ''}`}
                    onClick={() => patch({ provider: p.id })}
                  >
                    {form.provider === p.id && <Icon name="check" size={13} />}
                    {p.label}
                  </span>
                ))}
              </div>

              <label className="field-label">Base URL</label>
              <input
                className="prompt-input cm-input"
                placeholder="https://api.openai.com/v1"
                value={form.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
              />

              <label className="field-label">API Key</label>
              <input
                className="prompt-input cm-input"
                type="password"
                placeholder="sk-… 或 ${ENV_VAR}"
                value={form.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
              />

              <label className="field-label">模型 ID</label>
              <input
                className="prompt-input cm-input"
                placeholder="gpt-4o / claude-3-5-sonnet / …"
                value={form.modelId}
                onChange={(e) => patch({ modelId: e.target.value })}
              />

              <label className="field-label">上下文窗口（可选，tokens）</label>
              <input
                className="prompt-input cm-input"
                type="number"
                placeholder="例如 200000"
                value={form.maxTokens ?? ''}
                onChange={(e) =>
                  patch({
                    maxTokens: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
              />

              <label className="cm-check">
                <input
                  type="checkbox"
                  checked={form.enabled !== false}
                  onChange={(e) => patch({ enabled: e.target.checked })}
                />
                启用此模型
              </label>
            </div>
          )}
        </div>

        <div className="modal-foot">
          {form ? (
            <>
              <button className="btn" onClick={() => setForm(null)}>
                返回
              </button>
              <button className="btn primary" disabled={busy} onClick={save}>
                {busy ? <span className="spinner" /> : <Icon name="check" size={14} />}
                保存
              </button>
            </>
          ) : (
            <button className="btn" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
