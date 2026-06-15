import { useEffect, useRef } from 'react';
import { useStore, type ChatItem, type SessionView } from '../../store';
import { Markdown } from '../Markdown';
import { ToolCall } from '../ToolCall';
import { Icon } from '../Icon';
import { AgentIcon } from '../AgentIcon';

export function ChatPane({ view }: { view: SessionView }) {
  const density = view.density;
  const openFile = useStore((s) => s.openFile);
  const rewindTo = useStore((s) => s.rewindTo);
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

  return (
    <div className="pane-body">
      <div className="transcript">
        {view.transcript.length === 0 && (
          <div className="empty" style={{ height: 280 }}>
            <div className="empty-inner">
              <span className="empty-mark">
                <Icon name="sparkle" size={24} />
              </span>
              <div className="empty-title">开始与 Easy Code 对话</div>
              <div className="hint">它会在 {view.meta.cwd} 中工作</div>
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
              userIndex={item.kind === 'user' ? userIndex : undefined}
              onOpenFile={(p) => void openFile(view.meta.id, p)}
              onRewind={(idx) => void rewindTo(view.meta.id, idx)}
            />
          );
        })}
        {showDots && (
          <div className="msg msg-assistant typing-row">
            {(view.meta.agentType === 'claude-code' || view.meta.agentType === 'codex') && (
              <AgentIcon agent={view.meta.agentType} size={18} className="typing-agent-ic" animated />
            )}
            <div className="typing-dots" aria-label="AI 正在响应">
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

function ChatItemView({
  item,
  density,
  userIndex,
  onOpenFile,
  onRewind,
}: {
  item: ChatItem;
  density: SessionView['density'];
  userIndex?: number;
  onOpenFile: (path: string) => void;
  onRewind: (beforeUserMessageIndex: number) => void;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg">
          <div className="msg-user">
            {item.images && item.images.length > 0 && (
              <div className="msg-images">
                {item.images.map((src, i) => (
                  <img key={i} className="msg-image" src={src} alt="附带图片" />
                ))}
              </div>
            )}
            {item.text && <span className="msg-user-text">{item.text}</span>}
            {userIndex !== undefined && (
              <button
                className="icon-btn rewind-btn"
                title="回退到此处（rewind）"
                onClick={() => onRewind(userIndex)}
              >
                <Icon name="rewind" size={14} />
              </button>
            )}
          </div>
        </div>
      );

    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <Markdown text={item.text} />
        </div>
      );

    case 'thought':
      if (density === 'summary') return null;
      return (
        <div className="msg msg-thought">
          <div className="thought-label">
            <Icon name="think" size={13} />
            思考
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
          defaultOpen={density === 'verbose'}
          onOpenFile={onOpenFile}
        />
      );

    default:
      return null;
  }
}
