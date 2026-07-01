import { useEffect, useRef, useState } from 'react';
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
  // Live gateway output. "running=true" only means the child process is alive —
  // it does NOT prove the WebSocket connected to Feishu. The real state (connect
  // handshake, scope audit, crashes) lives in the child's output, exposed here.
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  // Manual form.
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [domain, setDomain] = useState<FeishuDomain>('feishu');

  // QR flow.
  const [qr, setQr] = useState<FeishuQrBegin | null>(null);

  // Authorization management (owner + allowlist), driven via /feishu pass-through.
  const [authBusy, setAuthBusy] = useState(false);
  const [ownerEditing, setOwnerEditing] = useState(false);
  const [ownerInput, setOwnerInput] = useState('');
  const [allowInput, setAllowInput] = useState('');

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
  const logText = status?.logTail?.trim() ?? '';

  // Keep the live log scrolled to the newest output while the panel is open.
  useEffect(() => {
    if (showLog && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logText, showLog]);

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
    // Reveal the live output immediately so the user can watch the gateway
    // actually connect (or fail) instead of trusting a static "running" badge.
    setShowLog(true);
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

  // Run a /feishu authorization subcommand (allow/deny/owner) through the
  // backend pass-through. Returns whether it succeeded so callers can clear
  // their input only on success. Refreshes status from the result.
  const runFeishu = async (args: string): Promise<boolean> => {
    setAuthBusy(true);
    setError('');
    setInfo('');
    const res = await api.feishu.runCommand(args);
    setAuthBusy(false);
    if (res.status) setStatus(res.status);
    if (!res.ok) {
      setError(res.error ?? t('feishu.auth.cmdFailed'));
      return false;
    }
    if (res.message) setInfo(res.message.trim());
    return true;
  };

  const beginEditOwner = () => {
    setOwnerInput(status?.ownerOpenId ?? '');
    setOwnerEditing(true);
  };
  const saveOwner = async () => {
    const id = ownerInput.trim();
    if (!id) return;
    if (await runFeishu(`owner ${id}`)) setOwnerEditing(false);
  };
  const addAllow = async () => {
    const id = allowInput.trim();
    if (!id) return;
    if (await runFeishu(`allow ${id}`)) setAllowInput('');
  };
  const removeAllow = (id: string) => void runFeishu(`deny ${id}`);

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
              </div>
            )}
          </div>

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

          {/* Authorization management: owner + allowlist. Graphical config that
              passes /feishu allow|deny|owner through to the backend (the exact
              CLI command logic), instead of typing slash commands by hand. */}
          {configured && mode === 'idle' && (
            <div className="feishu-auth">
              <div className="feishu-auth-head">
                <Icon name="shield" size={14} />
                <span>{t('feishu.auth.title')}</span>
              </div>

              {/* Owner */}
              <div className="feishu-auth-row">
                <span className="feishu-auth-key">{t('feishu.auth.ownerLabel')}</span>
                {ownerEditing ? (
                  <div className="feishu-auth-edit">
                    <input
                      className="prompt-input cm-input"
                      placeholder={t('feishu.auth.ownerPlaceholder')}
                      value={ownerInput}
                      onChange={(e) => setOwnerInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveOwner();
                        if (e.key === 'Escape') setOwnerEditing(false);
                      }}
                      autoFocus
                    />
                    <button
                      className="btn primary"
                      disabled={authBusy || !ownerInput.trim()}
                      onClick={() => void saveOwner()}
                    >
                      {authBusy ? <span className="spinner" /> : <Icon name="check" size={13} />}
                      {t('feishu.auth.save')}
                    </button>
                    <button className="btn ghost" disabled={authBusy} onClick={() => setOwnerEditing(false)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <div className="feishu-auth-owner-view">
                    <code className="feishu-auth-id" title={status?.ownerOpenId}>
                      {status?.ownerOpenId || t('feishu.auth.ownerNone')}
                    </code>
                    {status?.ownerOpenId && (
                      <span
                        className={`feishu-auth-badge ${status?.ownerVerified === false ? 'pending' : 'ok'}`}
                      >
                        {status?.ownerVerified === false
                          ? t('feishu.auth.unverified')
                          : t('feishu.auth.verified')}
                      </span>
                    )}
                    <button className="btn ghost" disabled={authBusy} onClick={beginEditOwner}>
                      <Icon name="edit" size={13} />
                      {t('feishu.auth.edit')}
                    </button>
                  </div>
                )}
              </div>
              <div className="feishu-auth-hint">{t('feishu.auth.ownerHint')}</div>

              {/* Allowlist */}
              <div className="feishu-auth-key feishu-auth-allow-label">
                {t('feishu.auth.allowlistLabel')}
              </div>
              {(status?.allowlist?.length ?? 0) === 0 ? (
                <div className="feishu-auth-empty">{t('feishu.auth.allowlistEmpty')}</div>
              ) : (
                <div className="feishu-auth-list">
                  {status?.allowlist?.map((id) => (
                    <div key={id} className="feishu-auth-item">
                      <code className="feishu-auth-id" title={id}>
                        {id}
                      </code>
                      <button
                        className="btn ghost"
                        disabled={authBusy}
                        onClick={() => removeAllow(id)}
                        title={t('feishu.auth.remove')}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="feishu-auth-add">
                <input
                  className="prompt-input cm-input"
                  placeholder={t('feishu.auth.allowPlaceholder')}
                  value={allowInput}
                  onChange={(e) => setAllowInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addAllow();
                  }}
                />
                <button
                  className="btn"
                  disabled={authBusy || !allowInput.trim()}
                  onClick={() => void addAllow()}
                >
                  {authBusy ? <span className="spinner" /> : <Icon name="plus" size={13} />}
                  {t('feishu.auth.add')}
                </button>
              </div>

              {running && <div className="feishu-auth-restart">{t('feishu.auth.restartHint')}</div>}
            </div>
          )}

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

          {/* Setup: choose a method when unconfigured. */}
          {!configured && mode === 'idle' && (
            <div className="feishu-setup">
              <div className="feishu-setup-platform">
                <span className="feishu-setup-platform-label">{t('feishu.platformLabel')}</span>
                <div className="seg feishu-setup-seg">
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
              <div className="feishu-method-cards">
                <button
                  className="feishu-method-card feishu-method-card--primary"
                  disabled={busy}
                  onClick={() => void startQr()}
                >
                  <span className="feishu-method-card__icon">
                    <Icon name="feishu" size={20} />
                  </span>
                  <span className="feishu-method-card__body">
                    <span className="feishu-method-card__title">
                      {t('feishu.qrLogin')}
                      <span className="feishu-method-card__badge">{domain === 'lark' ? 'Recommended' : '推荐'}</span>
                    </span>
                    <span className="feishu-method-card__desc">{t('feishu.qrLoginDesc')}</span>
                  </span>
                  <span className="feishu-method-card__arrow">›</span>
                </button>
                <button
                  className="feishu-method-card"
                  disabled={busy}
                  onClick={() => setMode('manual')}
                >
                  <span className="feishu-method-card__icon">
                    <Icon name="edit" size={18} />
                  </span>
                  <span className="feishu-method-card__body">
                    <span className="feishu-method-card__title">{t('feishu.manualEntry')}</span>
                    <span className="feishu-method-card__desc">{t('feishu.manualEntryDesc')}</span>
                  </span>
                  <span className="feishu-method-card__arrow">›</span>
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

          {/* Live gateway output — the real diagnostic surface. A "running"
              badge only means the child process is alive; whether it actually
              connected to Feishu is only visible in this output. */}
          {configured && (logText || running) && (
            <div className="feishu-logpanel">
              <button
                type="button"
                className="feishu-logpanel-head"
                onClick={() => setShowLog((v) => !v)}
              >
                <Icon name={showLog ? 'chevron-down' : 'chevron-right'} size={13} />
                <span>{t('feishu.detailsLog')}</span>
                {running && <span className="status-dot idle" />}
                {logText && (
                  <span className="feishu-logpanel-size">
                    {t('feishu.detailsLogSize', { n: logText.length })}
                  </span>
                )}
              </button>
              {showLog && (
                <pre className="feishu-logpanel-body" ref={logRef}>
                  {logText || t('feishu.detailsLogEmpty')}
                </pre>
              )}
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
