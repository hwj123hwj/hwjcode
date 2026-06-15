import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Icon } from './Icon';
import type {
  FeishuBinding,
  FeishuDomain,
  FeishuExternalProcess,
  FeishuQrBegin,
  FeishuStatus,
} from '@shared/ipc';

const api = window.easycode;

function uptime(startedAt?: number): string {
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

/** A chat counts as "active" if it ran a session within this window. */
const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

function relTime(ts?: number): string {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
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
function chatLabel(b: FeishuBinding): string {
  if (b.chatName) return b.chatName;
  if (b.isP2p) return '与机器人的私聊';
  const id = b.chatId || '';
  return id.length > 12 ? `…${id.slice(-8)}` : id || '未知会话';
}

/** Last two path segments of a project root, for a compact display. */
function shortProject(root?: string): string {
  if (!root) return '未绑定项目';
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
      setError('请填写 App ID 与 App Secret。');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    const res = await api.feishu.saveManual({ appId, appSecret, domain });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? '保存失败');
      return;
    }
    if (res.status) setStatus(res.status);
    setMode('idle');
    setAppId('');
    setAppSecret('');
    setInfo('凭证已验证并保存。');
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
      setError(beginRes.error ?? '发起扫码失败');
      return;
    }
    setQr(beginRes.begin);
    // Long-running: resolves when the user scans + approves (or it times out).
    const pollRes = await api.feishu.qrPoll(beginRes.begin);
    setBusy(false);
    setQr(null);
    setMode('idle');
    if (!pollRes.ok) {
      setError(pollRes.error ?? '扫码失败');
      return;
    }
    if (pollRes.status) setStatus(pollRes.status);
    setInfo('扫码登录成功，凭证已保存。');
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
      setError(res.error ?? '启动失败');
      return;
    }
    setInfo(
      res.killedExternal
        ? `已接管：关闭了 ${res.killedExternal} 个外部网关并启动桌面版网关。`
        : '飞书网关已启动。',
    );
    void refreshExternal();
  };

  const stop = async () => {
    setBusy(true);
    setError('');
    const s = await api.feishu.stop();
    setStatus(s);
    setBusy(false);
    setInfo('飞书网关已停止。');
  };

  const takeover = async () => {
    setBusy(true);
    const n = await api.feishu.killExternal();
    setBusy(false);
    setExternal([]);
    setInfo(`已关闭 ${n} 个外部网关进程，现在可由桌面版启动并管理。`);
  };

  const clearCreds = async () => {
    setBusy(true);
    setError('');
    const s = await api.feishu.clear();
    setStatus(s);
    setBusy(false);
    setInfo('已清除飞书凭证。');
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
            飞书 / Lark 网关
          </h3>
          <div className="sub">
            桌面版内置飞书网关，负责配置凭证与启停管理。
          </div>
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
                检测到 {external.length} 个由 CLI 独立启动的飞书网关。一台机器只能运行一个网关，
                否则消息路由会混乱。建议关闭它们并改由桌面版管理。
              </div>
              <button className="btn primary" disabled={busy} onClick={() => void takeover()}>
                关闭并接管
              </button>
            </div>
          )}

          {/* Status card. */}
          <div className="feishu-status">
            <div className="feishu-status-row">
              <span className={`status-dot ${running ? 'idle' : 'exited'}`} />
              <span className="feishu-status-title">
                {running ? '网关运行中' : configured ? '网关已停止' : '尚未配置'}
              </span>
              {running && status?.pid != null && (
                <span className="feishu-meta">pid {status.pid}</span>
              )}
              {running && status?.startedAt && (
                <span className="feishu-meta">已运行 {uptime(status.startedAt)}</span>
              )}
            </div>
            {configured && (
              <div className="feishu-status-sub">
                {status?.botName && <span>Bot：{status.botName}</span>}
                <span>平台：{status?.platform === 'lark' ? 'Lark' : '飞书'}</span>
                {status?.ownerOpenId && (
                  <span title={status.ownerOpenId}>
                    Owner：{status.ownerOpenId.slice(0, 10)}…
                  </span>
                )}
                {!!status?.allowlistCount && <span>白名单：{status.allowlistCount}</span>}
              </div>
            )}
          </div>

          {/* Lobby: project↔group bindings + recent activity (GUI counterpart
              of the CLI's TUI dashboard). Shown once configured. */}
          {configured && mode === 'idle' && (
            <div className="feishu-lobby">
              <div className="feishu-lobby-head">
                <Icon name="chat" size={14} />
                <span>项目 / 群绑定</span>
                <span className="feishu-lobby-count">{bindings.length}</span>
              </div>
              {bindings.length === 0 ? (
                <div className="feishu-lobby-empty">
                  暂无绑定。在飞书中 @ 机器人并发送消息，即可把当前群与一个项目自动绑定。
                </div>
              ) : (
                <div className="feishu-lobby-list">
                  {bindings.map((b) => {
                    const active = !!b.lastSessionAt && Date.now() - b.lastSessionAt < ACTIVE_WINDOW_MS;
                    return (
                      <div key={b.chatId} className={`feishu-bind ${active ? 'active' : ''}`}>
                        <div className="feishu-bind-row">
                          <span className={`status-dot ${active ? 'idle' : 'exited'}`} />
                          <span className="feishu-bind-name" title={b.chatId}>
                            {chatLabel(b)}
                          </span>
                          {b.isP2p && <span className="feishu-bind-tag">私聊</span>}
                          {active && <span className="feishu-bind-tag live">活跃</span>}
                          <span className="feishu-bind-time">{relTime(b.lastSessionAt)}</span>
                        </div>
                        <div className="feishu-bind-row sub">
                          <span className="feishu-bind-proj" title={b.projectRoot}>
                            <Icon name="folder" size={12} />
                            {shortProject(b.projectRoot)}
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
                  停止网关
                </button>
              ) : (
                <button className="btn primary" disabled={busy} onClick={() => void start()}>
                  <Icon name="play" size={14} />
                  启动网关
                </button>
              )}
              <button className="btn" disabled={busy} onClick={() => setMode('manual')}>
                重新配置
              </button>
              <button className="btn ghost" disabled={busy || running} onClick={() => void clearCreds()}>
                退出登录
              </button>
            </div>
          )}

          {/* Setup: choose a method when unconfigured. */}
          {!configured && mode === 'idle' && (
            <div className="feishu-setup">
              <div className="feishu-domain">
                <span className="field-label">平台</span>
                <div className="seg">
                  {(['feishu', 'lark'] as const).map((d) => (
                    <button
                      key={d}
                      className={domain === d ? 'active' : ''}
                      onClick={() => setDomain(d)}
                    >
                      {d === 'feishu' ? '飞书' : 'Lark'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="feishu-methods">
                <button className="btn primary" disabled={busy} onClick={() => void startQr()}>
                  <Icon name="feishu" size={14} />
                  扫码登录（自动建应用）
                </button>
                <button className="btn" disabled={busy} onClick={() => setMode('manual')}>
                  手动输入凭据
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
                    使用{domain === 'lark' ? ' Lark ' : '飞书'}扫描二维码并授权创建应用。
                    {qr.userCode && (
                      <>
                        {' '}
                        验证码 <code>{qr.userCode}</code>
                      </>
                    )}
                  </div>
                  <div className="feishu-actions">
                    <button className="btn" onClick={openQrUrl}>
                      <Icon name="globe" size={14} />
                      在浏览器打开
                    </button>
                    <button className="btn ghost" onClick={() => void cancelQr()}>
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <div className="cm-empty">
                  <span className="spinner" /> 正在发起扫码…
                </div>
              )}
            </div>
          )}

          {/* Manual credential entry. */}
          {mode === 'manual' && (
            <div className="cm-form">
              <label className="field-label">平台</label>
              <div className="seg">
                {(['feishu', 'lark'] as const).map((d) => (
                  <button key={d} className={domain === d ? 'active' : ''} onClick={() => setDomain(d)}>
                    {d === 'feishu' ? '飞书' : 'Lark'}
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
                placeholder="应用密钥"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
              />

              <div className="feishu-actions">
                <button className="btn primary" disabled={busy} onClick={() => void submitManual()}>
                  {busy ? <span className="spinner" /> : <Icon name="check" size={14} />}
                  验证并保存
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => setMode('idle')}>
                  返回
                </button>
              </div>
            </div>
          )}

          {status?.lastError && (
            <div className="feishu-logtail" title={status.lastError}>
              最近错误：{status.lastError}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
