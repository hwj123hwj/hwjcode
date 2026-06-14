import { useState } from 'react';
import { useStore } from '../store';

const api = window.easycode;

/**
 * The desktop's own login entry. Two paths, both writing to the shared
 * credential store the CLI uses, so logging in here logs you in there too:
 *   - browser/OAuth (core AuthServer on :7862)
 *   - API key (exchanged at the proxy server for a JWT)
 */
export function Login() {
  const auth = useStore((s) => s.auth);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<false | 'apikey' | 'browser'>(false);
  const [error, setError] = useState('');

  const loginApiKey = async () => {
    setBusy('apikey');
    setError('');
    const res = await api.auth.loginApiKey(apiKey);
    setBusy(false);
    if (!res.ok) setError(res.error ?? '登录失败');
    // On success, App re-renders via the auth:changed event.
  };

  const loginBrowser = async () => {
    setBusy('browser');
    setError('');
    const res = await api.auth.loginBrowser();
    if (!res.ok) {
      setBusy(false);
      setError(res.error ?? '无法启动浏览器登录');
    }
    // Stays "busy" until auth:changed flips us out of the login screen.
  };

  return (
    <div className="login">
      <div className="login-card">
        <h1>
          <span style={{ width: 18, height: 18, borderRadius: 6, background: 'var(--accent)' }} />
          Easy Code
        </h1>
        <p className="tagline">登录以开始 — 与 CLI 共享同一登录凭证</p>

        {error && <div className="login-err">{error}</div>}

        <button className="btn primary full" disabled={!!busy} onClick={loginBrowser}>
          {busy === 'browser' ? <span className="spinner" /> : '🌐'} 浏览器登录
        </button>
        {busy === 'browser' && (
          <p className="hint">
            已在浏览器打开登录页（{auth?.serverUrl}）。完成后将自动进入。
            <button
              className="icon-btn"
              onClick={() => {
                void api.auth.cancelBrowserLogin();
                setBusy(false);
              }}
            >
              取消
            </button>
          </p>
        )}

        <div className="divider">或</div>

        <label>API Key</label>
        <input
          type="password"
          placeholder="粘贴你的 API Key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && apiKey.trim() && loginApiKey()}
        />
        <button className="btn full" disabled={!!busy || !apiKey.trim()} onClick={loginApiKey}>
          {busy === 'apikey' ? <span className="spinner" /> : '用 API Key 登录'}
        </button>
      </div>
    </div>
  );
}
