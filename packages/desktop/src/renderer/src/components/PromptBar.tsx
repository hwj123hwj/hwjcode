import { useEffect, useRef, useState } from 'react';
import { useStore, type SessionView } from '../store';
import { Icon, type IconName } from './Icon';
import { AgentIcon } from './AgentIcon';
import {
  PERMISSION_MODES,
  type AgentKind,
  type DirEntry,
  type PermissionMode,
} from '@shared/ipc';

const api = window.easycode;

/** Label + icon for the agent chip shown on external-agent sessions. */
const AGENT_BADGE: Record<Exclude<AgentKind, 'easy-code'>, { label: string; icon: IconName }> = {
  'claude-code': { label: 'Claude Code', icon: 'cpu' },
  codex: { label: 'Codex', icon: 'terminal' },
};

/**
 * A prompt attachment. Images are inlined as base64 (sent through ACP as image
 * content blocks); non-image files ride the existing @-path mechanism so the
 * backend reads their content.
 */
type Attachment =
  | { id: string; kind: 'image'; name: string; mimeType: string; data: string; url: string }
  | { id: string; kind: 'file'; name: string; path: string };

let attachSeq = 0;
const nextAttachId = () => `att-${Date.now().toString(36)}-${(attachSeq++).toString(36)}`;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/**
 * Read a File (pasted/dropped) as a `data:` URL. We deliberately avoid
 * `URL.createObjectURL` here: the renderer CSP allows `img-src data:` but NOT
 * `blob:`, so loading a blob URL into the `<img>`/canvas inside compressImage
 * failed silently and pasting an image did nothing.
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Downscale + re-encode an image to JPEG (max 1920×1080, quality ~0.82) via an
 * offscreen canvas, mirroring the vscode-ui-plugin composer. Keeps payloads
 * small for the model. SVGs and any failure fall back to the original bytes.
 * Returns base64 WITHOUT the `data:` prefix.
 */
async function compressImage(
  srcUrl: string,
  origMime: string,
): Promise<{ mimeType: string; data: string }> {
  const stripPrefix = (u: string) => u.slice(u.indexOf(',') + 1);
  if (origMime === 'image/svg+xml') {
    return { mimeType: origMime, data: srcUrl.startsWith('data:') ? stripPrefix(srcUrl) : '' };
  }
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = srcUrl;
    });
    const maxW = 1920;
    const maxH = 1080;
    let { width, height } = img;
    const scale = Math.min(1, maxW / width, maxH / height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    return { mimeType: 'image/jpeg', data: stripPrefix(dataUrl) };
  } catch {
    // Fall back to the original bytes if the canvas path fails.
    if (srcUrl.startsWith('data:')) return { mimeType: origMime, data: stripPrefix(srcUrl) };
    return { mimeType: origMime, data: '' };
  }
}

export function PromptBar({ view }: { view: SessionView }) {
  const sendPrompt = useStore((s) => s.sendPrompt);
  const cancel = useStore((s) => s.cancel);
  const setMode = useStore((s) => s.setMode);
  const setModel = useStore((s) => s.setModel);

  const [text, setText] = useState('');
  const [atPaths, setAtPaths] = useState<Record<string, string>>({}); // name -> abs path
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mention, setMention] = useState<{ token: string; entries: DirEntry[]; active: number } | null>(
    null,
  );
  const taRef = useRef<HTMLTextAreaElement>(null);

  const addImageFromUrl = async (url: string, origMime: string, name: string) => {
    const { mimeType, data } = await compressImage(url, origMime);
    if (!data) return;
    setAttachments((a) => [
      ...a,
      { id: nextAttachId(), kind: 'image', name, mimeType, data, url: `data:${mimeType};base64,${data}` },
    ]);
  };

  /** Ctrl+V image paste: intercept image clipboard items, leave text alone. */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const images = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (images.length > 0) {
      e.preventDefault();
      for (const it of images) {
        const file = it.getAsFile();
        if (!file) continue;
        // data: URL (not blob:) so the CSP lets compressImage load it.
        void fileToDataUrl(file)
          .then((dataUrl) => addImageFromUrl(dataUrl, file.type, file.name || 'pasted-image.png'))
          .catch(() => undefined);
      }
      return;
    }
    // No image DataTransferItem. If there's real text, this is a normal text
    // paste — let it through. Otherwise the clipboard may hold a bitmap that
    // Windows doesn't expose as an item; consult the main-process clipboard.
    if (e.clipboardData?.getData('text/plain')) return;
    e.preventDefault();
    void api.clipboard.readImage().then((img) => {
      if (img?.data) {
        void addImageFromUrl(`data:${img.mimeType};base64,${img.data}`, img.mimeType, 'pasted-image.png');
      }
    });
  };

  /** Attach button: native file picker. Images inline; other files ride @-paths. */
  const pickAttachments = async () => {
    const files = await api.workspace.pickFiles().catch(() => []);
    for (const f of files) {
      if (IMAGE_EXT.test(f.name)) {
        const b64 = await api.workspace.readFileBase64(f.path).catch(() => null);
        if (b64) {
          await addImageFromUrl(`data:${b64.mimeType};base64,${b64.data}`, b64.mimeType, f.name);
          continue;
        }
      }
      setAttachments((a) =>
        a.some((x) => x.kind === 'file' && x.path === f.path)
          ? a
          : [...a, { id: nextAttachId(), kind: 'file', name: f.name, path: f.path }],
      );
    }
  };

  const removeAttachment = (id: string) => setAttachments((a) => a.filter((x) => x.id !== id));

  const meta = view.meta;
  const busy = meta.status === 'thinking' || meta.status === 'starting' || meta.status === 'needs_approval';

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [text]);

  const updateMention = async (value: string) => {
    const m = value.match(/@([\w./-]*)$/);
    if (!m) {
      setMention(null);
      return;
    }
    const token = m[1];
    const entries = await api.workspace.listDir(meta.cwd).catch(() => []);
    const filtered = entries
      .filter((e) => e.name.toLowerCase().includes(token.toLowerCase()))
      .slice(0, 12);
    setMention({ token, entries: filtered, active: 0 });
  };

  const onChange = (value: string) => {
    setText(value);
    void updateMention(value);
  };

  const pickMention = (entry: DirEntry) => {
    const next = text.replace(/@([\w./-]*)$/, `@${entry.name} `);
    setText(next);
    setAtPaths((p) => ({ ...p, [entry.name]: entry.path }));
    setMention(null);
    taRef.current?.focus();
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    // Resolve @names that match selected mentions to absolute paths, plus any
    // non-image file attachments (the backend reads them as @-references).
    const mentionPaths = Object.entries(atPaths)
      .filter(([name]) => trimmed.includes(`@${name}`))
      .map(([, p]) => p);
    const filePaths = attachments
      .filter((a): a is Extract<Attachment, { kind: 'file' }> => a.kind === 'file')
      .map((a) => a.path);
    const imageAtts = attachments.filter(
      (a): a is Extract<Attachment, { kind: 'image' }> => a.kind === 'image',
    );
    setText('');
    setAtPaths({});
    setMention(null);
    setAttachments([]);

    // Inline the (compressed) bytes for multimodal models …
    const images = imageAtts.map((a) => ({ mimeType: a.mimeType, data: a.data }));
    // … and also drop each image to a real file under the workspace, surfacing
    // its absolute path in the text. Text-only models can then reach it via the
    // image_reader tool — which keys off the path's extension, so persisting
    // with a proper suffix is what fixes "Unsupported image extension """.
    const hints: string[] = [];
    for (const a of imageAtts) {
      const saved = await api.workspace
        .saveClipboardImage(meta.cwd, a.mimeType, a.data, a.name)
        .catch(() => null);
      if (saved) hints.push(`[IMAGE: ${a.name} (${saved})]`);
    }
    const finalText = hints.length
      ? `${trimmed}${trimmed ? '\n\n' : ''}${hints.join('\n')}`
      : trimmed;

    await sendPrompt(meta.id, finalText, [...mentionPaths, ...filePaths], images);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mention.entries.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention({ ...mention, active: (mention.active + 1) % mention.entries.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention({
          ...mention,
          active: (mention.active - 1 + mention.entries.length) % mention.entries.length,
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mention.entries[mention.active]);
        return;
      }
      if (e.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const ctxPct =
    (meta.tokenUsed ?? 0) > 0 && meta.tokenSize
      ? Math.round((meta.tokenUsed! / meta.tokenSize) * 100)
      : null;

  return (
    <div className="promptbar">
      <div className="promptbar-inner">
        <div className="prompt-config">
          <span className="chip">
            <Icon name="laptop" size={14} />
            本地
          </span>
          <span className="chip" title={meta.cwd}>
            <Icon name="folder" size={14} />
            {projectName(meta.cwd)}
          </span>
          {meta.agentType && meta.agentType !== 'easy-code' && (
            <span className="chip accent" title="驱动此会话的外部 agent">
              <AgentIcon agent={meta.agentType} size={15} />
              {AGENT_BADGE[meta.agentType].label}
            </span>
          )}
          <span className="chip">
            <Icon name="cpu" size={14} />
            <select value={meta.model ?? ''} onChange={(e) => void setModel(meta.id, e.target.value)}>
              {!meta.model && <option value="">默认模型</option>}
              {(meta.availableModels ?? []).map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.name}
                </option>
              ))}
            </select>
          </span>
          {/* Permission modes are an Easy Code concept; external agents drive
              their own approval flow (surfaced via the permission dialog). */}
          {(!meta.agentType || meta.agentType === 'easy-code') && (
            <span className="chip accent">
              <Icon name="shield" size={14} />
              <select
                value={meta.permissionMode}
                onChange={(e) => void setMode(meta.id, e.target.value as PermissionMode)}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.id} value={m.id} title={m.hint}>
                    {m.label}
                  </option>
                ))}
              </select>
            </span>
          )}
          {ctxPct != null ? (
            <span className="chip" title="上下文用量">
              <span className="token-bar">
                <div style={{ width: `${Math.min(100, ctxPct)}%` }} />
              </span>
              {ctxPct}%
            </span>
          ) : null}
        </div>

        {attachments.length > 0 && (
          <div className="prompt-attachments">
            {attachments.map((a) =>
              a.kind === 'image' ? (
                <div key={a.id} className="attach-thumb" title={a.name}>
                  <img src={a.url} alt={a.name} />
                  <button
                    className="attach-remove"
                    title="移除"
                    onClick={() => removeAttachment(a.id)}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ) : (
                <div key={a.id} className="attach-chip" title={a.path}>
                  <Icon name="file" size={13} />
                  <span className="attach-name">{a.name}</span>
                  <button
                    className="attach-remove inline"
                    title="移除"
                    onClick={() => removeAttachment(a.id)}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ),
            )}
          </div>
        )}

        <div className="prompt-input-wrap" style={{ position: 'relative' }}>
          {mention && mention.entries.length > 0 && (
            <div className="mention-pop">
              {mention.entries.map((e, i) => (
                <div
                  key={e.path}
                  className={`mention-item ${i === mention.active ? 'active' : ''}`}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    pickMention(e);
                  }}
                >
                  <Icon name={e.isDir ? 'folder' : 'file'} size={14} />
                  <span>{e.name}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            className="prompt-input"
            rows={1}
            placeholder={busy ? '回复将在当前动作结束后被读取…（边跑边纠偏）' : '输入指令，@ 引用文件，/ 使用命令…'}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <button className="btn-attach" title="添加附件 / 图片" onClick={() => void pickAttachments()}>
            <Icon name="paperclip" size={16} />
          </button>
          {busy ? (
            <button className="btn-stop" onClick={() => void cancel(meta.id)}>
              <Icon name="stop" size={14} />
              停止
            </button>
          ) : null}
          <button
            className="btn-send"
            disabled={!text.trim() && attachments.length === 0}
            onClick={() => void submit()}
          >
            <Icon name="send" size={16} />
          </button>
        </div>
        <div className="hint">Enter 发送 · Shift+Enter 换行 · Ctrl+V 粘贴图片 · 点击回形针添加附件</div>
      </div>
    </div>
  );
}

function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}
