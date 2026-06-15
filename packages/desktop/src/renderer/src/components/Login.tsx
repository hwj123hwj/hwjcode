import { useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { useT } from '../i18n/useT';

const api = window.easycode;

/**
 * The desktop's own login entry. Two paths, both writing to the shared
 * credential store the CLI uses, so logging in here logs you in there too:
 *   - browser/OAuth (core AuthServer on :7862)
 *   - API key (exchanged at the proxy server for a JWT)
 */
export function Login() {
  const auth = useStore((s) => s.auth);
  const t = useT();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<false | 'apikey' | 'browser'>(false);
  const [error, setError] = useState('');

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
      </div>
    </div>
  );
}
