import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { useT } from '../i18n/useT';
import { SettingsDialog } from './SettingsDialog';

const api = window.easycode;

/**
 * The desktop's own login entry. Three paths:
 *   - browser/OAuth (core AuthServer on :7862)
 *   - API key (exchanged at the proxy server for a JWT)
 *   - custom models — use the app with your own API keys without signing in,
 *     mirroring the VSCode UI. Both auth paths write to the shared credential
 *     store the CLI uses; the custom-model path flips a renderer-only flag that
 *     bypasses the auth gate in <App>.
 */
export function Login() {
  const auth = useStore((s) => s.auth);
  const enterCustomModelMode = useStore((s) => s.enterCustomModelMode);
  const t = useT();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<false | 'apikey' | 'browser' | 'custom'>(false);
  const [error, setError] = useState('');
  /** Whether the user has at least one enabled custom model on disk. */
  const [hasCustomModels, setHasCustomModels] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Probe the shared custom-models store so we can offer the right entry point:
  // "continue with custom models" when some exist, "add a custom model"
  // otherwise. Re-checked after the settings dialog closes (the user may have
  // just added one there).
  const refreshCustomModels = useCallback(async () => {
    try {
      const models = await api.models.listCustom();
      setHasCustomModels(models.some((m) => m.enabled !== false));
    } catch {
      setHasCustomModels(false);
    }
  }, []);

  useEffect(() => {
    void refreshCustomModels();
  }, [refreshCustomModels]);

  const loginApiKey = async () => {
    setBusy('apikey');
    setError('');
    const res = await api.auth.loginApiKey(apiKey);
    setBusy(false);
    if (!res.ok) setError(res.error ?? t('login.failed'));
    // On success, App re-renders via the auth:changed event.
  };

  const loginBrowser = async () => {
    setBusy('browser');
    setError('');
    const res = await api.auth.loginBrowser();
    if (!res.ok) {
      setBusy(false);
      setError(res.error ?? t('login.browserFailed'));
    }
    // Stays "busy" until auth:changed flips us out of the login screen.
  };

  // Enter custom-model-only mode. Succeeds (and <App> swaps in the main UI) only
  // if there's an enabled custom model; otherwise nudge the user to add one.
  const useCustomModels = async () => {
    setBusy('custom');
    setError('');
    const ok = await enterCustomModelMode();
    setBusy(false);
    if (!ok) {
      setError(t('login.noCustomModels'));
      setShowSettings(true);
    }
  };

  // The settings dialog closed — the user may have added a model. Refresh, and
  // if one now exists, enter custom-model mode straight away.
  const onSettingsClosed = async () => {
    setShowSettings(false);
    await refreshCustomModels();
    void enterCustomModelMode();
  };

  return (
    <div className="login">
      <div className="login-card">
        <h1>
          <span className="brand-mark" style={{ width: 32, height: 32, borderRadius: 9 }}>
            <Icon name="sparkle" size={17} />
          </span>
          Easy Code
        </h1>
        <p className="tagline">{t('login.tagline')}</p>

        {error && (
          <div className="login-err">
            <Icon name="alert" size={15} />
            {error}
          </div>
        )}

        <button className="btn primary full" disabled={!!busy} onClick={loginBrowser}>
          {busy === 'browser' ? <span className="spinner" /> : <Icon name="globe" size={15} />}
          {t('login.browser')}
        </button>
        {busy === 'browser' && (
          <p className="hint">
            {t('login.browserHint', { url: auth?.serverUrl ?? '' })}
            <button
              className="icon-btn"
              onClick={() => {
                void api.auth.cancelBrowserLogin();
                setBusy(false);
              }}
            >
              {t('common.cancel')}
            </button>
          </p>
        )}

        <div className="divider">{t('login.or')}</div>

        <label>API Key</label>
        <input
          type="password"
          placeholder={t('login.apiKeyPlaceholder')}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && apiKey.trim() && loginApiKey()}
        />
        <button className="btn full" disabled={!!busy || !apiKey.trim()} onClick={loginApiKey}>
          {busy === 'apikey' ? <span className="spinner" /> : t('login.apiKeyLogin')}
        </button>

        <div className="divider">{t('login.or')}</div>

        {/* Custom-model path: no sign-in required. Shows "continue" when models
            exist, otherwise "add a model" (which opens settings). */}
        {hasCustomModels ? (
          <button className="btn full" disabled={!!busy} onClick={useCustomModels}>
            {busy === 'custom' ? <span className="spinner" /> : <Icon name="cpu" size={15} />}
            {t('login.useCustomModels')}
          </button>
        ) : (
          <button className="btn full" disabled={!!busy} onClick={() => setShowSettings(true)}>
            <Icon name="plus" size={15} />
            {t('login.addCustomModel')}
          </button>
        )}
        <p className="hint">{t('login.customModelHint')}</p>
      </div>

      {showSettings && <SettingsDialog onClose={onSettingsClosed} initialTab="models" />}
    </div>
  );
}
