import { useEffect, useRef, useState } from 'react';
import { useStore, type ChatItem, type SessionView } from '../../store';
import { Markdown } from '../Markdown';
import { ToolCall } from '../ToolCall';
import { Icon } from '../Icon';
import { AgentIcon } from '../AgentIcon';
import { useT, type TFunc } from '../../i18n/useT';

export function ChatPane({ view }: { view: SessionView }) {
  const density = view.density;
  // Clicking a file location in the transcript opens it in the Codex-style
  // Files panel (multi-tab viewer) rather than the legacy single-file pane.
  const openFile = useStore((s) => s.openFileTab);
  const rewindTo = useStore((s) => s.rewindTo);
  const t = useT();
  const bottomRef = useRef<HTMLDivElement>(null);

  // The backend reports 'thinking' from prompt submit through turn_end (covering
  // model streaming and tool runs) and 'starting' while the bridge spins up. In
  // either state the agent is working, so show the typing indicator.
  const busy = view.meta.status === 'thinking' || view.meta.status === 'starting';
  // Once the assistant has started streaming visible text this turn, the bubble
  // itself shows progress — only show the standalone dots before that.
  const last = view.transcript[view.transcript.length - 1];
  const showDots = busy && (!last || last.kind !== 'assistant');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [view.transcript, showDots]);

  let userIndex = -1;
  const totalUserMessages = view.transcript.filter((x) => x.kind === 'user').length;

  return (
    <div className="pane-body">
      <div className="transcript">
        {view.transcript.length === 0 && (
          <div className="empty" style={{ height: 280 }}>
            <div className="empty-inner">
              <span className="empty-mark">
                <Icon name="sparkle" size={24} />
              </span>
              <div className="empty-title">{t('chat.emptyTitle')}</div>
              <div className="hint">{t('chat.worksIn', { cwd: view.meta.cwd })}</div>
            </div>
          </div>
        )}
        {view.transcript.map((item) => {
          if (item.kind === 'user') userIndex++;
          return (
            <ChatItemView
              key={item.id}
              item={item}
              density={density}
              t={t}
              userIndex={item.kind === 'user' ? userIndex : undefined}
              isLastUser={item.kind === 'user' && userIndex === totalUserMessages - 1}
              sessionId={view.meta.id}
              onOpenFile={(p) => openFile(p)}
              onRewind={(idx) => void rewindTo(view.meta.id, idx)}
            />
          );
        })}
        {showDots && (
          <div className="msg msg-assistant typing-row">
            {(view.meta.agentType === 'claude-code' || view.meta.agentType === 'codex') && (
              <AgentIcon agent={view.meta.agentType} size={18} className="typing-agent-ic" animated />
            )}
            <div className="typing-dots" aria-label={t('chat.aiResponding')}>
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function formatTimestamp(ts?: number, lang: string = 'zh'): string {
  const val = ts || Date.now();
  const d = new Date(val);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  const pad = (n: number) => n.toString().padStart(2, '0');
  const hrs = pad(d.getHours());
  const mins = pad(d.getMinutes());

  if (isToday) {
    return `${hrs}:${mins}`;
  } else {
    if (lang === 'zh') {
      return `${d.getMonth() + 1}月${d.getDate()}日 ${hrs}:${mins}`;
    } else {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[d.getMonth()]} ${d.getDate()} ${hrs}:${mins}`;
    }
  }
}

function ChatItemView({
  item,
  density,
  t,
  userIndex,
  isLastUser,
  sessionId,
  onOpenFile,
  onRewind,
}: {
  item: ChatItem;
  density: SessionView['density'];
  t: TFunc;
  userIndex?: number;
  isLastUser?: boolean;
  sessionId: string;
  onOpenFile: (path: string) => void;
  onRewind: (beforeUserMessageIndex: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const lang = useStore((s) => s.lang);
  const setPromptDraft = useStore((s) => s.setPromptDraft);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleEdit = () => {
    if (userIndex !== undefined) {
      onRewind(userIndex);
      setPromptDraft(sessionId, item.text);
    }
  };

  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user-row">
          <div className="msg-user">
            {item.images && item.images.length > 0 && (
              <div className="msg-images">
                {item.images.map((src, i) => (
                  <img key={i} className="msg-image" src={src} alt={t('chat.attachedImage')} />
                ))}
              </div>
            )}
            {item.text && <span className="msg-user-text">{item.text}</span>}
          </div>
          <div className="msg-user-meta">
            <span className="msg-meta-time">{formatTimestamp(item.timestamp, lang)}</span>
            <button className="msg-meta-btn" onClick={() => handleCopy(item.text)} title={t('common.copy')}>
              <Icon name={copied ? 'check' : 'copy'} size={13} />
            </button>
            {isLastUser && userIndex !== undefined && (
              <button className="msg-meta-btn" onClick={handleEdit} title={t('chat.rewindTitle')}>
                <Icon name="edit" size={13} />
              </button>
            )}
          </div>
        </div>
      );

    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <Markdown text={item.text} />
          <div className="msg-assistant-meta">
            <span className="msg-meta-time">{formatTimestamp(item.timestamp, lang)}</span>
            <button className="msg-meta-btn" onClick={() => handleCopy(item.text)} title={t('common.copy')}>
              <Icon name={copied ? 'check' : 'copy'} size={13} />
            </button>
          </div>
        </div>
      );

    case 'thought':
      if (density === 'summary') return null;
      return (
        <div className="msg msg-thought">
          <div className="thought-label">
            <Icon name="think" size={13} />
            {t('chat.thought')}
          </div>
          {item.text}
        </div>
      );

    case 'system':
      if (density === 'summary') return null;
      return <div className="msg-system">{item.text}</div>;

    case 'error':
      return (
        <div className="msg msg-error">
          <Icon name="alert" size={16} />
          <span>{item.text}</span>
        </div>
      );

    case 'tool':
      if (density === 'summary') return null;
      return (
        <ToolCall
          title={item.title}
          toolKind={item.toolKind}
          status={item.status}
          locations={item.locations}
          content={item.content}
          terminalOutput={item.terminalOutput}
          rawInput={item.rawInput}
          defaultOpen={density === 'verbose'}
          onOpenFile={onOpenFile}
        />
      );

    default:
      return null;
  }
}
