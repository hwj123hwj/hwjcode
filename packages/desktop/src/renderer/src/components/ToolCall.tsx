import { useState } from 'react';
import type { AcpToolKind, ToolCallContent, ToolCallStatus, ToolLocation } from '@shared/ipc';

const KIND_ICON: Record<AcpToolKind, string> = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '📦',
  search: '🔍',
  execute: '⚡',
  think: '💭',
  fetch: '🌐',
  switch_mode: '🔄',
  other: '🔧',
};

const STATUS_LABEL: Record<ToolCallStatus, string> = {
  pending: '等待',
  in_progress: '执行中',
  completed: '完成',
  failed: '失败',
};

export interface ToolCallProps {
  title: string;
  toolKind: AcpToolKind;
  status: ToolCallStatus;
  locations?: ToolLocation[];
  content: ToolCallContent[];
  terminalOutput?: string;
  defaultOpen: boolean;
  onOpenFile?: (path: string) => void;
}

export function ToolCall({
  title,
  toolKind,
  status,
  locations,
  content,
  terminalOutput,
  defaultOpen,
  onOpenFile,
}: ToolCallProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hasBody =
    content.some((c) => c.text || c.diff) || !!terminalOutput || (locations?.length ?? 0) > 0;

  return (
    <div className="tool">
      <div className="tool-head" onClick={() => hasBody && setOpen(!open)}>
        <span className="tool-ico">{KIND_ICON[toolKind] ?? '🔧'}</span>
        <span className="tool-title">{title}</span>
        {(status === 'pending' || status === 'in_progress') && <span className="spinner" />}
        <span className={`tool-status ${status}`}>{STATUS_LABEL[status]}</span>
        {hasBody && <span style={{ color: 'var(--text-faint)' }}>{open ? '▾' : '▸'}</span>}
      </div>
      {open && hasBody && (
        <div className="tool-body">
          {locations && locations.length > 0 && (
            <div style={{ marginBottom: 6, color: 'var(--text-dim)' }}>
              {locations.map((l, i) => (
                <span
                  key={i}
                  style={{ cursor: onOpenFile ? 'pointer' : 'default', marginRight: 10 }}
                  onClick={() => onOpenFile?.(l.path)}
                >
                  {l.path}
                  {l.line ? `:${l.line}` : ''}
                </span>
              ))}
            </div>
          )}
          {content.map((c, i) => {
            if (c.diff) {
              return <DiffPreview key={i} path={c.diff.path} oldText={c.diff.oldText} newText={c.diff.newText} />;
            }
            if (c.text) {
              return (
                <div key={i} style={{ marginBottom: 6 }}>
                  {c.text}
                </div>
              );
            }
            return null;
          })}
          {terminalOutput && <div className="console">{terminalOutput}</div>}
        </div>
      )}
    </div>
  );
}

function DiffPreview({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
}) {
  const label = oldText ? `编辑 ${path}` : `写入 ${path}`;
  const oldLines = (oldText ?? '').split('\n');
  const newLines = newText.split('\n');
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>{label}</div>
      {oldText
        ? oldLines.map((l, i) => (
            <div key={`o${i}`} className="diff-line del">
              <span>- {l}</span>
            </div>
          ))
        : null}
      {newLines.map((l, i) => (
        <div key={`n${i}`} className="diff-line add">
          <span>+ {l}</span>
        </div>
      ))}
    </div>
  );
}
