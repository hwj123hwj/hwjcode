import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { Icon, type IconName } from './Icon';
import { AgentIcon } from './AgentIcon';
import { useT } from '../i18n/useT';
import { type TranslationKey } from '../i18n/i18n';
import {
  PERMISSION_MODES,
  type AgentKind,
  type ExternalAgentAvailability,
  type PermissionMode,
} from '@shared/ipc';

const api = window.easycode;

/** Agent backends, in display order. Easy Code is always available; the
 *  external ones appear only when detected on the user's PATH. */
const AGENTS: {
  id: AgentKind;
  label: string;
  icon: IconName;
  hint: TranslationKey;
}[] = [
  { id: 'easy-code', label: 'Easy Code', icon: 'sparkle', hint: 'agent.easyCodeHint' },
  { id: 'claude-code', label: 'Claude Code', icon: 'cpu', hint: 'agent.claudeCodeHint' },
  { id: 'codex', label: 'Codex', icon: 'terminal', hint: 'agent.codexHint' },
];

/** Last path segment of a project directory (handles both / and \ separators). */
function projectName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const seg = trimmed.split(/[/\\]/).pop();
  return seg || trimmed;
}

/** Max recent-project shortcuts to surface, to keep the dialog uncluttered. */
const MAX_RECENT_PROJECTS = 6;

/**
 * Whether to show the "Environment" selector. Hidden for now because only local
 * mode is supported — the single "Local" chip just wastes vertical space. Kept
 * behind a flag (rather than deleted) so remote environments can restore it.
 */
const SHOW_ENVIRONMENT = false;

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const createSession = useStore((s) => s.createSession);
  const createChatSession = useStore((s) => s.createChatSession);
  const sessions = useStore((s) => s.sessions);
  const order = useStore((s) => s.order);
  const t = useT();

  // Recent project directories, deduced from existing project sessions. `order`
  // is newest-first, so iterating it and deduping by path yields most-recent-first
  // unique directories; cap the count so the dialog stays tidy.
  const recentProjects = useMemo(() => {
    const seen = new Set<string>();
    const result: { path: string; name: string }[] = [];
    for (const id of order) {
      const meta = sessions[id]?.meta;
      if (!meta || meta.kind !== 'project') continue;
      const path = meta.cwd?.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      result.push({ path, name: projectName(path) });
      if (result.length >= MAX_RECENT_PROJECTS) break;
    }
    return result;
  }, [sessions, order]);
  // 'project' binds a working directory; 'chat' is a directory-less "just chat"
  // session (the Chats section) — no folder to pick.
  const [sessionType, setSessionType] = useState<'project' | 'chat'>('project');
  const [cwd, setCwd] = useState('');
  const [agent, setAgent] = useState<AgentKind>('easy-code');
  const [available, setAvailable] = useState<ExternalAgentAvailability>({
    claudeCode: false,
    codex: false,
  });
  const [mode, setMode] = useState<PermissionMode>('yolo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Probe for local Claude Code / Codex once, so the picker only offers agents
  // the machine can actually launch.
  useEffect(() => {
    let alive = true;
    void api.agents.detect().then((a) => {
      if (alive) setAvailable(a);
    });
    return () => {
      alive = false;
    };
  }, []);

  const agentOptions = AGENTS.filter(
    (a) =>
      a.id === 'easy-code' ||
      (a.id === 'claude-code' && available.claudeCode) ||
      (a.id === 'codex' && available.codex),
  );

  const pick = async () => {
    const folder = await api.workspace.pickFolder();
    if (folder) setCwd(folder);
  };

  const start = async () => {
    // A 闲聊 session is directory-less; a 项目 session needs a working directory.
    if (sessionType === 'project' && !cwd.trim()) {
      setError(t('newSession.pickDirError'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (sessionType === 'chat') {
        await createChatSession(mode, agent);
      } else {
        await createSession(cwd, mode, agent);
      }
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
            {t('newSession.title')}
          </h3>
          <div className="sub">{t('newSession.subtitle')}</div>
        </div>
        <div className="modal-body">
          {error && (
            <div className="login-err">
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}
          {/* Environment selector — hidden while only local mode is supported.
              Flip SHOW_ENVIRONMENT back to true when remote environments land. */}
          {SHOW_ENVIRONMENT && (
            <>
              <label className="field-label">{t('newSession.environment')}</label>
              <div className="prompt-config">
                <span className="chip accent">
                  <Icon name="laptop" size={14} />
                  {t('common.local')}
                </span>
              </div>
            </>
          )}

          <label className="field-label">{t('newSession.type')}</label>
          <div className="prompt-config">
            <span
              className={`chip interactive ${sessionType === 'project' ? 'accent' : ''}`}
              title={t('newSession.typeProjectHint')}
              onClick={() => setSessionType('project')}
            >
              {sessionType === 'project' && <Icon name="check" size={13} />}
              <Icon name="folder-open" size={14} />
              {t('newSession.typeProject')}
            </span>
            <span
              className={`chip interactive ${sessionType === 'chat' ? 'accent' : ''}`}
              title={t('newSession.typeChatHint')}
              onClick={() => setSessionType('chat')}
            >
              {sessionType === 'chat' && <Icon name="check" size={13} />}
              <Icon name="sparkle" size={14} />
              {t('newSession.typeChat')}
            </span>
          </div>

          <label className="field-label">Agent</label>
          <div className="prompt-config">
            {agentOptions.map((a) => (
              <span
                key={a.id}
                className={`chip interactive ${agent === a.id ? 'accent' : ''}`}
                title={t(a.hint)}
                onClick={() => setAgent(a.id)}
              >
                {agent === a.id && <Icon name="check" size={13} />}
                <AgentIcon agent={a.id} size={15} />
                {a.label}
              </span>
            ))}
          </div>

          {sessionType === 'project' && (
            <>
              <label className="field-label">{t('newSession.projectDir')}</label>
              {recentProjects.length > 0 && (
                <div className="recent-projects">
                  <div className="sub recent-projects-label">{t('newSession.recentProjects')}</div>
                  <div className="prompt-config">
                    {recentProjects.map((p) => (
                      <span
                        key={p.path}
                        className={`chip interactive ${cwd === p.path ? 'accent' : ''}`}
                        title={p.path}
                        onClick={() => setCwd(p.path)}
                      >
                        {cwd === p.path && <Icon name="check" size={13} />}
                        <Icon name="folder" size={14} />
                        {p.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="dir-picker">
                <input
                  className="dir-picker-input"
                  placeholder={t('newSession.pickFolderPlaceholder')}
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
                <button className="btn dir-picker-browse" onClick={pick}>
                  <Icon name="folder-open" size={14} />
                  {t('newSession.browse')}
                </button>
              </div>
            </>
          )}

          {agent === 'easy-code' ? (
            <>
              <label className="field-label">{t('newSession.permissionMode')}</label>
              <div className="prompt-config">
                {PERMISSION_MODES.map((m) => (
                  <span
                    key={m.id}
                    className={`chip interactive ${mode === m.id ? 'accent' : ''}`}
                    title={t(`permMode.${m.id}.hint`)}
                    onClick={() => setMode(m.id)}
                  >
                    {mode === m.id && <Icon name="check" size={13} />}
                    {t(`permMode.${m.id}`)}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="sub" style={{ marginTop: 8 }}>
              {t('newSession.externalAgentNote', {
                agent: agentOptions.find((a) => a.id === agent)?.label ?? '',
              })}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy} onClick={start}>
            {busy ? <span className="spinner" /> : <Icon name="play" size={14} />}
            {t('newSession.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
