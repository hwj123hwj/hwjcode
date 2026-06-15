import { useState } from 'react';
import type { AcpToolKind, ToolCallContent, ToolCallStatus, ToolLocation } from '@shared/ipc';
import { Icon, toolKindIcon } from './Icon';

const STATUS_LABEL: Record<ToolCallStatus, string> = {
  pending: '等待',
  in_progress: '执行中',
  completed: '完成',
  failed: '失败',
};

/** Accent tone applied to the tool icon chip, by kind. */
function kindTone(kind: AcpToolKind): string {
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'k-edit';
  if (kind === 'execute') return 'k-execute';
  return '';
}

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
  const running = status === 'pending' || status === 'in_progress';

  return (
    <div className="tool">
      <div className="tool-head" onClick={() => hasBody && setOpen(!open)}>
        <span className={`tool-ico ${kindTone(toolKind)}`}>
          <Icon name={toolKindIcon(toolKind)} size={15} />
        </span>
        <span className="tool-title">{title}</span>
        <span className={`tool-status ${status}`}>
          {running && <Icon name="loader" size={11} spin />}
          {STATUS_LABEL[status]}
        </span>
        {hasBody && (
          <span className="tool-chevron">
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={15} />
          </span>
        )}
      </div>
      {open && hasBody && (
        <div className="tool-body">
          {locations && locations.length > 0 && (
            <div className="tool-locations">
              {locations.map((l, i) => (
                <span
                  key={i}
                  className="tool-loc"
                  style={{ cursor: onOpenFile ? 'pointer' : 'default' }}
                  onClick={() => onOpenFile?.(l.path)}
                >
                  <Icon name="file" size={12} />
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
                <div key={i} className="tool-text">
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
  const oldLines = (oldText ?? '').split('\n');
  const newLines = newText.split('\n');
  return (
    <div className="diff-preview">
      <div className="diff-preview-head">
        <Icon name={oldText ? 'edit' : 'file'} size={13} />
        {oldText ? '编辑' : '写入'} {path}
      </div>
      <div style={{ overflowX: 'auto' }}>
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
    </div>
  );
}
