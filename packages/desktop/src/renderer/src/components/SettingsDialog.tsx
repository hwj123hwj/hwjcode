import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n/useT';
import { useStore } from '../store';
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
  const t = useT();
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);

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
    if (!form.displayName.trim()) return setError(t('settings.errName'));
    if (!form.baseUrl.trim()) return setError(t('settings.errBaseUrl'));
    if (!form.apiKey.trim()) return setError(t('settings.errApiKey'));
    if (!form.modelId.trim()) return setError(t('settings.errModelId'));
    setBusy(true);
    setError('');
    const res = await api.models.saveCustom(form, editingName);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t('settings.saveFailed'));
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
            {t('settings.title')}
          </h3>
          <div className="sub">
            {t('settings.subtitlePre')}<code>~/.easycode-user/custom-models.json</code>{t('settings.subtitlePost')}
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
            <div className="settings-lang">
              <label className="field-label">{t('settings.language')}</label>
              <div className="prompt-config">
                {(['zh', 'en'] as const).map((l) => (
                  <span
                    key={l}
                    className={`chip interactive ${lang === l ? 'accent' : ''}`}
                    onClick={() => setLang(l)}
                  >
                    {lang === l && <Icon name="check" size={13} />}
                    {l === 'zh' ? t('settings.langZh') : t('settings.langEn')}
                  </span>
                ))}
              </div>
            </div>
          )}

          {!form && (
            <>
              <div className="cm-list">
                {loading && (
                  <div className="cm-empty">
                    <span className="spinner" /> {t('common.loading')}
                  </div>
                )}
                {!loading && models.length === 0 && (
                  <div className="cm-empty">{t('settings.noModels')}</div>
                )}
                {models.map((m) => (
                  <div className="cm-row" key={m.id}>
                    <div className="cm-row-main">
                      <span className="cm-name">{m.displayName}</span>
                      <span className="cm-badge">
                        {PROVIDERS.find((p) => p.id === m.provider)?.label ?? m.provider}
                      </span>
                      {m.enabled === false && <span className="cm-badge muted">{t('settings.disabled')}</span>}
                    </div>
                    <div className="cm-row-sub">
                      {m.modelId} · {m.baseUrl}
                    </div>
                    <div className="cm-actions">
                      <button className="icon-btn" title={t('common.edit')} onClick={() => startEdit(m)}>
                        <Icon name="edit" size={14} />
                      </button>
                      <button className="icon-btn" title={t('common.delete')} onClick={() => void remove(m)}>
                        <Icon name="delete" size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn" onClick={startAdd}>
                <Icon name="plus" size={14} />
                {t('settings.addModel')}
              </button>
            </>
          )}

          {form && (
            <div className="cm-form">
              <label className="field-label">{t('settings.name')}</label>
              <input
                className="prompt-input cm-input"
                placeholder={t('settings.namePlaceholder')}
                value={form.displayName}
                onChange={(e) => patch({ displayName: e.target.value })}
              />

              <label className="field-label">{t('settings.provider')}</label>
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
                placeholder={t('settings.apiKeyPlaceholder')}
                value={form.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
              />

              <label className="field-label">{t('settings.modelId')}</label>
              <input
                className="prompt-input cm-input"
                placeholder="gpt-4o / claude-3-5-sonnet / …"
                value={form.modelId}
                onChange={(e) => patch({ modelId: e.target.value })}
              />

              <label className="field-label">{t('settings.contextWindow')}</label>
              <input
                className="prompt-input cm-input"
                type="number"
                placeholder={t('settings.contextWindowPlaceholder')}
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
                {t('settings.enableModel')}
              </label>
            </div>
          )}
        </div>

        <div className="modal-foot">
          {form ? (
            <>
              <button className="btn" onClick={() => setForm(null)}>
                {t('common.back')}
              </button>
              <button className="btn primary" disabled={busy} onClick={save}>
                {busy ? <span className="spinner" /> : <Icon name="check" size={14} />}
                {t('common.save')}
              </button>
            </>
          ) : (
            <button className="btn" onClick={onClose}>
              {t('common.close')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
