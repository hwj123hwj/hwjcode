import { useEffect, useRef } from 'react';
import { useStore, type ChatItem, type SessionView } from '../../store';
import { Markdown } from '../Markdown';
import { ToolCall } from '../ToolCall';

export function ChatPane({ view }: { view: SessionView }) {
  const density = view.density;
  const openFile = useStore((s) => s.openFile);
  const rewindTo = useStore((s) => s.rewindTo);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [view.transcript]);

  let userIndex = -1;

  return (
    <div className="pane-body">
      <div className="transcript">
        {view.transcript.length === 0 && (
          <div className="empty" style={{ height: 240 }}>
            <div>
              <div style={{ fontSize: 32, marginBottom: 8 }}>✦</div>
              开始与 Easy Code 对话
              <div className="hint" style={{ marginTop: 6 }}>
                它会在 {view.meta.cwd} 中工作
              </div>
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
        <div className="msg" style={{ position: 'relative' }}>
          <div className="msg-user">{item.text}</div>
          {userIndex !== undefined && (
            <button
              className="icon-btn"
              title="回退到此处（rewind）"
              style={{ position: 'absolute', top: 4, right: 4 }}
              onClick={() => onRewind(userIndex)}
            >
              ⏪
            </button>
          )}
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
        <div className="msg msg-thought">{item.text}</div>
      );

    case 'system':
      if (density === 'summary') return null;
      return <div className="msg-system">{item.text}</div>;

    case 'error':
      return <div className="msg msg-error">{item.text}</div>;

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
