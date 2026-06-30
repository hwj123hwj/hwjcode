import { useEffect, useRef, useState } from 'react';
import { useStore, type ChatItem, type SessionView, type ViewDensity } from '../../store';
import { Markdown } from '../Markdown';
import { ToolCall } from '../ToolCall';
import { Icon, toolKindIcon } from '../Icon';
import { AgentIcon } from '../AgentIcon';
import { useT, type TFunc } from '../../i18n/useT';

/** A `kind: 'tool'` transcript entry. */
type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** One render slot: either a normal chat item, or a run of consecutive tools. */
type RenderUnit =
  | { type: 'item'; item: ChatItem; userIndex?: number; isLastUser: boolean }
  | { type: 'tools'; key: string; items: ToolItem[] };

const isToolRunning = (it: ToolItem): boolean =>
  it.status === 'pending' || it.status === 'in_progress';

/** Whether a tool call has anything to show when expanded (mirrors ToolCall). */
const toolHasBody = (it: ToolItem): boolean =>
  it.content.some((c) => c.text || c.diff) ||
  !!it.terminalOutput ||
  (it.locations?.length ?? 0) > 0;

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

  // Fold the flat transcript into render units, merging runs of consecutive tool
  // calls so they can collapse under a single "已运行 X 条命令" header. Non-tool
  // items (and tools while in summary density, which are hidden) pass through.
  const totalUserMessages = view.transcript.filter((x) => x.kind === 'user').length;
  const units: RenderUnit[] = [];
  let userIndex = -1;
  for (const item of view.transcript) {
    if (item.kind === 'tool' && density !== 'summary') {
      const last = units[units.length - 1];
      if (last && last.type === 'tools') {
        last.items.push(item);
      } else {
        units.push({ type: 'tools', key: `tools-${item.id}`, items: [item] });
      }
      continue;
    }
    if (item.kind === 'user') userIndex++;
    units.push({
      type: 'item',
      item,
      userIndex: item.kind === 'user' ? userIndex : undefined,
      isLastUser: item.kind === 'user' && userIndex === totalUserMessages - 1,
    });
  }

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
        {units.map((u) =>
          u.type === 'tools' ? (
            <ToolGroup
              key={u.key}
              items={u.items}
              density={density}
              t={t}
              onOpenFile={(p) => openFile(p)}
            />
          ) : (
            <ChatItemView
              key={u.item.id}
              item={u.item}
              density={density}
              t={t}
              userIndex={u.userIndex}
              isLastUser={u.isLastUser}
              sessionId={view.meta.id}
              onOpenFile={(p) => openFile(p)}
              onRewind={(idx) => void rewindTo(view.meta.id, idx)}
            />
          ),
        )}
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
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(item.text);
  const editTaRef = useRef<HTMLTextAreaElement>(null);

  const lang = useStore((s) => s.lang);
  const rewindTo = useStore((s) => s.rewindTo);
  const sendPrompt = useStore((s) => s.sendPrompt);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSave = async () => {
    if (!editText.trim()) return;
    setIsEditing(false);
    await rewindTo(sessionId, userIndex!);
    await sendPrompt(sessionId, editText, [], []);
  };

  useEffect(() => {
    if (isEditing && editTaRef.current) {
      const ta = editTaRef.current;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 250) + 'px';
    }
  }, [editText, isEditing]);

  switch (item.kind) {
    case 'user':
      if (isEditing) {
        return (
          <div className="msg-user-row editing">
            <div className="msg-user">
              <textarea
                ref={editTaRef}
                className="msg-user-edit-input"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSave();
                  } else if (e.key === 'Escape') {
                    setIsEditing(false);
                    setEditText(item.text);
                  }
                }}
                autoFocus
              />
              <div className="msg-user-edit-actions">
                <button className="btn primary xsmall" onClick={handleSave}>
                  {t('common.save') ?? '保存'}
                </button>
                <button className="btn xsmall" onClick={() => {
                  setIsEditing(false);
                  setEditText(item.text);
                }}>
                  {t('common.cancel') ?? '取消'}
                </button>
              </div>
            </div>
          </div>
        );
      }
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
              <button className="msg-meta-btn" onClick={() => setIsEditing(true)} title={t('chat.rewindTitle')}>
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

/**
 * A run of consecutive tool calls. Three-layer fold:
 *  - Layer 0: a single "已运行 X 条命令" header that collapses the whole run
 *    (multi-item runs only). Auto-expands while any tool is still running and in
 *    verbose density; once the run finishes it auto-collapses, unless the user
 *    has toggled it manually.
 *  - Layer 1: each tool as a weak single-line summary ({@link ToolEntry}).
 *  - Layer 2: clicking a summary expands the full {@link ToolCall} detail.
 */
function ToolGroup({
  items,
  density,
  t,
  onOpenFile,
}: {
  items: ToolItem[];
  density: ViewDensity;
  t: TFunc;
  onOpenFile: (path: string) => void;
}) {
  const [groupOverride, setGroupOverride] = useState<boolean | null>(null);
  const isMulti = items.length > 1;
  const anyRunning = items.some(isToolRunning);
  const groupDefault = anyRunning || density === 'verbose';
  const groupOpen = !isMulti || (groupOverride ?? groupDefault);

  return (
    <div className="tool-group">
      {isMulti && (
        <button
          className="tool-group-head"
          onClick={() => setGroupOverride(!(groupOverride ?? groupDefault))}
        >
          <Icon name="terminal" size={13} className="tool-group-ico" />
          <span className="tool-group-label">{t('tool.ranCount', { n: items.length })}</span>
          {anyRunning && <Icon name="loader" size={11} spin />}
          <Icon
            name={groupOpen ? 'chevron-down' : 'chevron-right'}
            size={14}
            className="tool-group-chevron"
          />
        </button>
      )}
      {groupOpen && (
        <div className={isMulti ? 'tool-group-items' : undefined}>
          {items.map((it) => (
            <ToolEntry
              key={it.id}
              item={it}
              density={density}
              t={t}
              indent={isMulti}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One tool call rendered as a weak single-line summary that expands to the full
 * {@link ToolCall} detail on click. Running tools (and verbose density) default
 * to expanded. The nested ToolCall's own head is hidden via CSS so this line is
 * the single header — keeping ToolCall itself unchanged.
 */
function ToolEntry({
  item,
  density,
  t,
  indent,
  onOpenFile,
}: {
  item: ToolItem;
  density: ViewDensity;
  t: TFunc;
  indent: boolean;
  onOpenFile: (path: string) => void;
}) {
  const hasBody = toolHasBody(item);
  const running = isToolRunning(item);
  const [override, setOverride] = useState<boolean | null>(null);
  const detailDefault = running || density === 'verbose';
  const open = hasBody && (override ?? detailDefault);

  return (
    <div className={`tool-entry${indent ? ' indent' : ''}${item.status === 'failed' ? ' failed' : ''}`}>
      <button
        className="tool-entry-line"
        title={item.title}
        style={{ cursor: hasBody ? 'pointer' : 'default' }}
        onClick={() => hasBody && setOverride(!(override ?? detailDefault))}
      >
        <Icon name={toolKindIcon(item.toolKind)} size={13} className="tool-entry-ico" />
        <span className="tool-entry-text">{t('tool.ranItem', { title: item.title })}</span>
        {running && <Icon name="loader" size={11} spin className="tool-entry-spin" />}
        {hasBody && (
          <Icon
            name={open ? 'chevron-down' : 'chevron-right'}
            size={12}
            className="tool-entry-chevron"
          />
        )}
      </button>
      {open && (
        <div className="tool-entry-detail">
          <ToolCall
            title={item.title}
            toolKind={item.toolKind}
            status={item.status}
            locations={item.locations}
            content={item.content}
            terminalOutput={item.terminalOutput}
            rawInput={item.rawInput}
            defaultOpen={true}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
    </div>
  );
}
