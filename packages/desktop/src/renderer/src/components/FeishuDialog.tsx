import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Icon } from './Icon';
import { useT, type TFunc } from '../i18n/useT';
import type {
  FeishuBinding,
  FeishuDomain,
  FeishuExternalProcess,
  FeishuQrBegin,
  FeishuStatus,
} from '@shared/ipc';

const api = window.easycode;

function uptime(t: TFunc, startedAt?: number): string {
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (s < 60) return t('time.seconds', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('time.minutes', { m });
  return t('time.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}

function relTime(t: TFunc, ts?: number): string {
  if (!ts) return t('time.never');
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('time.justNow');
  if (m < 60) return t('time.minutesAgo', { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.hoursAgo', { h });
  return t('time.daysAgo', { d: Math.floor(h / 24) });
}

/** Label for a binding's backing agent. */
function agentLabel(agent?: string): string {
  switch (agent) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    default:
      return 'Easy Code';
  }
}

/** Friendly chat label: group name → P2P → trimmed chatId. */
function chatLabel(t: TFunc, b: FeishuBinding): string {
  if (b.chatName) return b.chatName;
  if (b.isP2p) return t('feishu.p2pChat');
  const id = b.chatId || '';
  return id.length > 12 ? `…${id.slice(-8)}` : id || t('feishu.unknownChat');
}

/** Last two path segments of a project root, for a compact display. */
function shortProject(t: TFunc, root?: string): string {
  if (!root) return t('feishu.noProject');
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? root : `…/${parts.slice(-2).join('/')}`;
}

/**
 * Feishu/Lark gateway management. The desktop app runs the gateway itself
 * (a bundled `--feishu` child); this dialog drives credential setup (QR scan or
 * manual entry, written to the shared `~/.easycode-user` store) and the
 * start/stop of that desktop-managed gateway child. It also detects a gateway
 * launched independently by the CLI and offers to take it over — a machine must
 * run exactly one gateway.
 */
export function FeishuDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<FeishuStatus | null>(null);
  const [external, setExternal] = useState<FeishuExternalProcess[]>([]);
  const [bindings, setBindings] = useState<FeishuBinding[]>([]);
  const [mode, setMode] = useState<'idle' | 'manual' | 'qr'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // Manual form.
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [domain, setDomain] = useState<FeishuDomain>('feishu');

  // QR flow.
  const [qr, setQr] = useState<FeishuQrBegin | null>(null);

  const refreshExternal = () =>
    api.feishu.detectExternal().then(setExternal).catch(() => setExternal([]));
  const refreshLobby = () =>
    api.feishu.lobby().then((l) => setBindings(l.bindings)).catch(() => undefined);

  useEffect(() => {
    void api.feishu.status().then(setStatus);
    void refreshExternal();
    void refreshLobby();
    const off = api.feishu.onChanged((s) => {
      setStatus(s);
      void refreshExternal();
      void refreshLobby();
    });
    // Poll the lobby so "active" badges + relative times stay fresh while open.
    const timer = window.setInterval(refreshLobby, 5000);
    return () => {
      off();
      window.clearInterval(timer);
      // Abort any in-flight QR poll if the dialog is dismissed mid-scan.
      void api.feishu.qrCancel();
    };
  }, []);

  const running = !!status?.running;
  const configured = !!status?.credsConfigured;

  const submitManual = async () => {
    if (!appId.trim() || !appSecret.trim()) {
      setError(t('feishu.fillAppIdSecret'));
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    const res = await api.feishu.saveManual({ appId, appSecret, domain });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t('feishu.saveFailed'));
      return;
    }
    if (res.status) setStatus(res.status);
    setMode('idle');
    setAppId('');
    setAppSecret('');
    setInfo(t('feishu.credsSaved'));
  };

  const startQr = async () => {
    setBusy(true);
    setError('');
    setInfo('');
    setQr(null);
    setMode('qr');
    const beginRes = await api.feishu.qrBegin(domain);
    if (!beginRes.ok || !beginRes.begin) {
      setBusy(false);
      setMode('idle');
      setError(beginRes.error ?? t('feishu.qrStartFailed'));
      return;
    }
    setQr(beginRes.begin);
    // Long-running: resolves when the user scans + approves (or it times out).
    const pollRes = await api.feishu.qrPoll(beginRes.begin);
    setBusy(false);
    setQr(null);
    setMode('idle');
    if (!pollRes.ok) {
      setError(pollRes.error ?? t('feishu.qrFailed'));
      return;
    }
    if (pollRes.status) setStatus(pollRes.status);
    setInfo(t('feishu.qrSuccess'));
  };

  const cancelQr = async () => {
    await api.feishu.qrCancel();
    setQr(null);
    setMode('idle');
    setBusy(false);
  };

  const start = async () => {
    setBusy(true);
    setError('');
    setInfo('');
    const res = await api.feishu.start();
    setBusy(false);
    if (res.status) setStatus(res.status);
    if (!res.ok) {
      setError(res.error ?? t('feishu.startFailed'));
      return;
    }
    setInfo(
      res.killedExternal
        ? t('feishu.takeoverStarted', { n: res.killedExternal })
        : t('feishu.gatewayStarted'),
    );
    void refreshExternal();
  };

  const stop = async () => {
    setBusy(true);
    setError('');
    const s = await api.feishu.stop();
    setStatus(s);
    setBusy(false);
    setInfo(t('feishu.gatewayStopped'));
  };

  const takeover = async () => {
    setBusy(true);
    const n = await api.feishu.killExternal();
    setBusy(false);
    setExternal([]);
    setInfo(t('feishu.externalKilled', { n }));
  };

  const clearCreds = async () => {
    setBusy(true);
    setError('');
    const s = await api.feishu.clear();
    setStatus(s);
    setBusy(false);
    setInfo(t('feishu.credsCleared'));
  };

  const openQrUrl = () => {
    if (qr) void api.workspace.openExternal(qr.qrUrl);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            <Icon name="feishu" size={17} />
            {t('feishu.title')}
          </h3>
          <div className="sub">{t('feishu.subtitle')}</div>
        </div>

        <div className="modal-body">
          {error && (
            <div className="login-err">
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}
          {info && !error && (
            <div className="feishu-info">
              <Icon name="circle-check" size={15} />
              {info}
            </div>
          )}

          {/* External (CLI-launched) gateway warning. */}
          {external.length > 0 && (
            <div className="feishu-warn">
              <div className="feishu-warn-text">
                <Icon name="alert" size={15} />
                {t('feishu.externalWarn', { n: external.length })}
              </div>
              <button className="btn primary" disabled={busy} onClick={() => void takeover()}>
                {t('feishu.takeover')}
              </button>
            </div>
          )}

          {/* Status card. */}
          <div className="feishu-status">
            <div className="feishu-status-row">
              <span className={`status-dot ${running ? 'idle' : 'exited'}`} />
              <span className="feishu-status-title">
                {running
                  ? t('feishu.gatewayRunning')
                  : configured
                    ? t('feishu.gatewayStoppedStatus')
                    : t('feishu.notConfigured')}
              </span>
              {running && status?.pid != null && (
                <span className="feishu-meta">pid {status.pid}</span>
              )}
              {running && status?.startedAt && (
                <span className="feishu-meta">{t('feishu.uptime', { time: uptime(t, status.startedAt) })}</span>
              )}
            </div>
            {configured && (
              <div className="feishu-status-sub">
                {status?.botName && <span>{t('feishu.bot', { name: status.botName })}</span>}
                <span>
                  {t('feishu.platform', {
                    name: status?.platform === 'lark' ? 'Lark' : t('feishu.platformFeishu'),
                  })}
                </span>
                {status?.ownerOpenId && (
                  <span title={status.ownerOpenId}>
                    {t('feishu.owner', { id: status.ownerOpenId.slice(0, 10) })}
                  </span>
                )}
                {!!status?.allowlistCount && <span>{t('feishu.allowlist', { n: status.allowlistCount })}</span>}
              </div>
            )}
          </div>

          {/* Lobby: project↔group bindings + recent activity (GUI counterpart
              of the CLI's TUI dashboard). Shown once configured. */}
          {configured && mode === 'idle' && (
            <div className="feishu-lobby">
              <div className="feishu-lobby-head">
                <Icon name="chat" size={14} />
                <span>{t('feishu.bindings')}</span>
                <span className="feishu-lobby-count">{bindings.length}</span>
              </div>
              {bindings.length === 0 ? (
                <div className="feishu-lobby-empty">{t('feishu.noBindings')}</div>
              ) : (
                <div className="feishu-lobby-list">
                  {bindings.map((b) => {
                    // Live "currently running a session" from the gateway, matching
                    // the CLI TUI's green "(Active)" indicator.
                    const active = !!b.active;
                    return (
                      <div key={b.chatId} className={`feishu-bind ${active ? 'active' : ''}`}>
                        <div className="feishu-bind-row">
                          <span className={`status-dot ${active ? 'idle' : 'exited'}`} />
                          <span className="feishu-bind-name" title={b.chatId}>
                            {chatLabel(t, b)}
                          </span>
                          {b.isP2p && <span className="feishu-bind-tag">{t('feishu.p2pTag')}</span>}
                          {active && <span className="feishu-bind-tag live">{t('feishu.activeTag')}</span>}
                          <span className="feishu-bind-time">
                            {active ? t('feishu.runningTag') : relTime(t, b.lastSessionAt)}
                          </span>
                        </div>
                        <div className="feishu-bind-row sub">
                          <span className="feishu-bind-proj" title={b.projectRoot}>
                            <Icon name="folder" size={12} />
                            {shortProject(t, b.projectRoot)}
                          </span>
                          <span className="feishu-bind-chip">{agentLabel(b.agent)}</span>
                          {b.model && <span className="feishu-bind-chip">{b.model}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Primary actions. */}
          {configured && mode === 'idle' && (
            <div className="feishu-actions">
              {running ? (
                <button className="btn danger" disabled={busy} onClick={() => void stop()}>
                  <Icon name="stop" size={14} />
                  {t('feishu.stopGateway')}
                </button>
              ) : (
                <button className="btn primary" disabled={busy} onClick={() => void start()}>
                  <Icon name="play" size={14} />
                  {t('feishu.startGateway')}
                </button>
              )}
              <button className="btn" disabled={busy} onClick={() => setMode('manual')}>
                {t('feishu.reconfigure')}
              </button>
              <button className="btn ghost" disabled={busy || running} onClick={() => void clearCreds()}>
                {t('common.logout')}
              </button>
            </div>
          )}

          {/* Setup: choose a method when unconfigured. */}
          {!configured && mode === 'idle' && (
            <div className="feishu-setup">
              <div className="feishu-domain">
                <span className="field-label">{t('feishu.platformLabel')}</span>
                <div className="seg">
                  {(['feishu', 'lark'] as const).map((d) => (
                    <button
                      key={d}
                      className={domain === d ? 'active' : ''}
                      onClick={() => setDomain(d)}
                    >
                      {d === 'feishu' ? t('feishu.platformFeishu') : 'Lark'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="feishu-methods">
                <button className="btn primary" disabled={busy} onClick={() => void startQr()}>
                  <Icon name="feishu" size={14} />
                  {t('feishu.qrLogin')}
                </button>
                <button className="btn" disabled={busy} onClick={() => setMode('manual')}>
                  {t('feishu.manualEntry')}
                </button>
              </div>
            </div>
          )}

          {/* QR scan. */}
          {mode === 'qr' && (
            <div className="feishu-qr">
              {qr ? (
                <>
                  <div className="feishu-qr-box">
                    <QRCodeSVG value={qr.qrUrl} size={184} includeMargin />
                  </div>
                  <div className="feishu-qr-hint">
                    {t('feishu.qrHint', { platform: domain === 'lark' ? 'Lark' : t('feishu.platformFeishu') })}
                    {qr.userCode && (
                      <>
                        {' '}
                        {t('feishu.verifyCode')} <code>{qr.userCode}</code>
                      </>
                    )}
                  </div>
                  <div className="feishu-actions">
                    <button className="btn" onClick={openQrUrl}>
                      <Icon name="globe" size={14} />
                      {t('feishu.openInBrowser')}
                    </button>
                    <button className="btn ghost" onClick={() => void cancelQr()}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </>
              ) : (
                <div className="cm-empty">
                  <span className="spinner" /> {t('feishu.qrStarting')}
                </div>
              )}
            </div>
          )}

          {/* Manual credential entry. */}
          {mode === 'manual' && (
            <div className="cm-form">
              <label className="field-label">{t('feishu.platformLabel')}</label>
              <div className="seg">
                {(['feishu', 'lark'] as const).map((d) => (
                  <button key={d} className={domain === d ? 'active' : ''} onClick={() => setDomain(d)}>
                    {d === 'feishu' ? t('feishu.platformFeishu') : 'Lark'}
                  </button>
                ))}
              </div>

              <label className="field-label">App ID</label>
              <input
                className="prompt-input cm-input"
                placeholder="cli_xxxxxxxxxxxx"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
              />

              <label className="field-label">App Secret</label>
              <input
                className="prompt-input cm-input"
                type="password"
                placeholder={t('feishu.appSecretPlaceholder')}
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
              />

              <div className="feishu-actions">
                <button className="btn primary" disabled={busy} onClick={() => void submitManual()}>
                  {busy ? <span className="spinner" /> : <Icon name="check" size={14} />}
                  {t('feishu.verifyAndSave')}
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => setMode('idle')}>
                  {t('common.back')}
                </button>
              </div>
            </div>
          )}

          {status?.lastError && (
            <div className="feishu-logtail" title={status.lastError}>
              {t('feishu.lastError', { msg: status.lastError })}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
