import { useEffect, useRef, useState } from 'react';
import { useStore, type SessionView } from '../store';
import { Icon, type IconName } from './Icon';
import { AgentIcon } from './AgentIcon';
import { CustomSelect } from './CustomSelect';
import { useT } from '../i18n/useT';
import {
  PERMISSION_MODES,
  type AgentKind,
  type DirEntry,
  type PermissionMode,
  type SlashCommand,
  type ThinkingMode,
} from '@shared/ipc';
import type { SelectOption } from './CustomSelect';

const api = window.easycode;

/**
 * The clipboard-paste shortcut, by platform: ⌘V on macOS, Ctrl+V elsewhere.
 * Computed once from the user agent (the renderer is a browser context, so
 * `navigator` is reliable; `data-platform` on <html> is set by preload too but
 * only consumed by CSS). Used in the prompt hint so the label matches the key
 * the user actually presses.
 */
const PASTE_SHORTCUT = /Mac|iPhone|iPad/i.test(
  typeof navigator !== 'undefined' ? navigator.userAgent : '',
)
  ? '⌘V'
  : 'Ctrl+V';

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
  const setThinking = useStore((s) => s.setThinking);
  const promptDraft = useStore((s) => s.sessions[view.meta.id]?.promptDraft);
  const setPromptDraft = useStore((s) => s.setPromptDraft);
  const t = useT();

  const [text, setText] = useState('');
  const [showCwdHint, setShowCwdHint] = useState(false);
  const [atPaths, setAtPaths] = useState<Record<string, string>>({}); // name -> abs path
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mention, setMention] = useState<{ token: string; entries: DirEntry[]; active: number } | null>(
    null,
  );
  // Slash-command autocomplete. Populated from `view.commands`, which the ACP
  // agent advertises via `available_commands_update` — the same set the CLI
  // exposes. Only shown while the whole input is a bare `/token` (no args yet).
  const [cmd, setCmd] = useState<{ matches: SlashCommand[]; active: number } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (promptDraft !== undefined) {
      setText(promptDraft);
      setPromptDraft(view.meta.id, undefined);
      // Give the focus slightly later to make sure text value has propagated
      setTimeout(() => taRef.current?.focus(), 50);
    }
  }, [promptDraft, view.meta.id, setPromptDraft]);

  useEffect(() => {
    if (!showCwdHint) return;
    const timer = setTimeout(() => setShowCwdHint(false), 3500);
    return () => clearTimeout(timer);
  }, [showCwdHint]);
  // True while an IME (e.g. Chinese pinyin) is composing. Using a ref — not
  // state — so onKeyDown reads the latest value synchronously without a
  // re-render race. macOS IMEs fire Enter to "commit" the composition; we must
  // NOT treat that Enter as a send.
  const isComposingRef = useRef(false);

  // Current git branch (+ dirty flag) of this session's working folder, shown
  // after the folder name as "name (branch*)". Re-queried when the cwd changes.
  const cwd = view.meta.cwd;
  const isChat = view.meta.kind === 'chat';
  const [git, setGit] = useState<{ branch: string; dirty: boolean } | null>(null);
  useEffect(() => {
    // Chat sessions have a throwaway, git-less cwd — skip the probe entirely.
    if (isChat) {
      setGit(null);
      return;
    }
    let alive = true;
    void api.workspace.gitBranch(cwd).then((g) => {
      if (alive) setGit(g);
    });
    return () => {
      alive = false;
    };
  }, [cwd, isChat]);

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

  /**
   * Show the slash-command popup while the input is a single `/token` with no
   * arguments yet. Matching is a case-insensitive substring on the command
   * name, so `/mem` surfaces `memory`, `memory show`, etc.
   */
  const updateCommand = (value: string) => {
    const m = value.match(/^\/([\w:-]*)$/);
    if (!m) {
      setCmd(null);
      return;
    }
    const token = m[1].toLowerCase();
    const matches = (view.commands ?? [])
      .filter((c) => c.name.toLowerCase().includes(token))
      .slice(0, 12);
    // If the token is the one and only command it matches, the user has typed a
    // complete command — hide the popup so Enter sends it instead of re-picking.
    if (matches.length === 1 && matches[0].name.toLowerCase() === token) {
      setCmd(null);
      return;
    }
    setCmd(matches.length > 0 ? { matches, active: 0 } : null);
  };

  const onChange = (value: string) => {
    setText(value);
    void updateMention(value);
    updateCommand(value);
  };

  const pickCommand = (c: SlashCommand) => {
    // Insert `/name ` (trailing space closes the popup); the user adds any args
    // and presses Enter, mirroring the CLI's insert-then-run behaviour.
    setText(`/${c.name} `);
    setCmd(null);
    taRef.current?.focus();
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
    setCmd(null);
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

  /**
   * Whether this keydown is the IME "commit" Enter rather than a real submit.
   * Triple-guarded because no single signal is reliable across macOS WebKit:
   *  - `nativeEvent.isComposing`: the standard, but on macOS it can already be
   *    false on the very Enter that ends composition.
   *  - `keyCode === 229`: legacy "in composition" sentinel still emitted here.
   *  - `isComposingRef`: our own compositionstart/end tracking as a backstop.
   */
  const isImeCommit = (e: React.KeyboardEvent<HTMLTextAreaElement>) =>
    e.nativeEvent.isComposing || e.keyCode === 229 || isComposingRef.current;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (cmd && cmd.matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCmd({ ...cmd, active: (cmd.active + 1) % cmd.matches.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCmd({
          ...cmd,
          active: (cmd.active - 1 + cmd.matches.length) % cmd.matches.length,
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        // While composing, Enter commits the IME candidate — don't hijack it.
        if (e.key === 'Enter' && isImeCommit(e)) return;
        e.preventDefault();
        pickCommand(cmd.matches[cmd.active]);
        return;
      }
      if (e.key === 'Escape') {
        setCmd(null);
        return;
      }
    }
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
        // While composing, Enter commits the IME candidate — don't hijack it to
        // pick a @-mention. (Tab still selects, IMEs don't use it to commit.)
        if (e.key === 'Enter' && isImeCommit(e)) return;
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
      // Let the IME's commit-Enter fall through to the textarea (upscreen the
      // candidate) instead of sending a half-typed message.
      if (isImeCommit(e)) return;
      e.preventDefault();
      void submit();
    }
  };

  const ctxPct =
    (meta.tokenUsed ?? 0) > 0 && meta.tokenSize
      ? Math.round((meta.tokenUsed! / meta.tokenSize) * 100)
      : null;

  // ── Model selector options, with an inline "Effort" submenu for extended
  //    thinking pinned at the TOP (so it stays visible above the long, scrollable
  //    model list). Shown for Easy Code sessions; external agents (Claude Code /
  //    Codex) drive their own reasoning controls, so it's hidden for them.
  const isEasyCode = !meta.agentType || meta.agentType === 'easy-code';
  const EFFORTS = ['low', 'medium', 'high', 'max'] as const;
  type Effort = (typeof EFFORTS)[number];
  const effortLabel = (e: Effort) => t(`thinking.effort.${e}`);
  // Fall back to 'auto' for display when the backend hasn't reported a value yet
  // (older backend, or session not fully started) so the control is never hidden.
  const thinking: ThinkingMode = meta.thinking ?? 'auto';
  const thinkingOn = thinking !== 'off';
  const currentEffort = (EFFORTS as readonly string[]).includes(thinking)
    ? (thinking as Effort)
    : undefined;
  const effortHint =
    thinking === 'off'
      ? t('thinking.state.off')
      : currentEffort
        ? effortLabel(currentEffort)
        : t('thinking.state.auto');

  const effortOption: SelectOption = {
    value: '__effort__',
    label: t('thinking.effort.title'),
    hint: effortHint,
    dividerAfter: true,
    submenu: {
      header: t('thinking.help'),
      value: currentEffort,
      onChange: (eff) => void setThinking(meta.id, eff as ThinkingMode),
      options: EFFORTS.map((e) => ({
        value: e,
        label: effortLabel(e),
        ...(e === 'low' ? { badge: t('thinking.default') } : {}),
      })),
      toggle: {
        label: t('thinking.title'),
        description: t('thinking.toggleDesc'),
        checked: thinkingOn,
        onChange: (on) => void setThinking(meta.id, on ? (currentEffort ?? 'low') : 'off'),
      },
    },
  };

  const modelOptions: SelectOption[] = [
    ...(isEasyCode ? [effortOption] : []),
    ...(!meta.model ? [{ value: '', label: t('prompt.defaultModel') }] : []),
    ...(meta.availableModels ?? []).map((m) => ({ value: m.modelId, label: m.name })),
  ];

  return (
    <div className="promptbar">
      <div className="promptbar-inner">
        <div className="prompt-config">
          {/* Directory chip is meaningless for directory-less chat sessions
              (their cwd is an internal ~/.easycode-user/chats/<id> folder), so
              only show it for project-bound sessions. */}
          {meta.kind !== 'chat' && (
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <button
                className="chip interactive"
                style={{ border: 'none', background: 'var(--bg-elev)', color: 'var(--text-dim)', padding: '5px 12px' }}
                title={meta.cwd}
                onClick={() => setShowCwdHint((s) => !s)}
              >
                <Icon name="folder" size={14} style={{ marginRight: '6px' }} />
                <span>{projectName(meta.cwd)}</span>
                {git && (
                  <span className="chip-branch" style={{ marginLeft: '4px' }}>
                    ({git.branch}
                    {git.dirty ? '*' : ''})
                  </span>
                )}
              </button>
              {showCwdHint && (
                <div className="menu-pop" style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 8px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: '260px',
                  padding: '10px 14px',
                  fontSize: '12.5px',
                  lineHeight: '1.45',
                  color: 'var(--text)',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: '10px',
                  boxShadow: 'var(--shadow-lg)',
                  zIndex: 9999,
                  textAlign: 'center',
                  whiteSpace: 'normal'
                }}>
                  {t('prompt.cwdHint')}
                </div>
              )}
            </div>
          )}
          {meta.agentType && meta.agentType !== 'easy-code' && (
            <span className="chip accent" title={t('prompt.externalAgentTitle')}>
              <AgentIcon agent={meta.agentType} size={15} />
              {AGENT_BADGE[meta.agentType].label}
            </span>
          )}
          <CustomSelect
            value={meta.model ?? ''}
            options={modelOptions}
            icon="cpu"
            preferUp
            onChange={(val) => void setModel(meta.id, val)}
          />
          {/* Permission modes are an Easy Code concept; external agents drive
              their own approval flow (surfaced via the permission dialog). */}
          {(!meta.agentType || meta.agentType === 'easy-code') && (
            <CustomSelect
              value={meta.permissionMode}
              options={PERMISSION_MODES.map((m) => ({
                value: m.id,
                label: t(`permMode.${m.id}`),
                description: t(`permMode.${m.id}.hint`),
              }))}
              icon="shield"
              accent
              preferUp
              onChange={(val) => void setMode(meta.id, val as PermissionMode)}
            />
          )}
          {ctxPct != null ? (
            <span className="chip" title={t('prompt.contextUsage')}>
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
                    title={t('common.remove')}
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
                    title={t('common.remove')}
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
          {cmd && cmd.matches.length > 0 && (
            <div className="command-pop">
              {cmd.matches.map((c, i) => (
                <div
                  key={c.name}
                  className={`command-item ${i === cmd.active ? 'active' : ''}`}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    pickCommand(c);
                  }}
                >
                  <span className="command-name">/{c.name}</span>
                  {c.description && <span className="command-desc">{c.description}</span>}
                </div>
              ))}
            </div>
          )}
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
            placeholder={busy ? t('prompt.busyPlaceholder') : t('prompt.placeholder')}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onPaste={onPaste}
          />
          <button className="btn-attach" title={t('prompt.addAttachment')} onClick={() => void pickAttachments()}>
            <Icon name="paperclip" size={16} />
          </button>
          {busy ? (
            <button className="btn-stop" onClick={() => void cancel(meta.id)}>
              <Icon name="stop" size={14} />
              {t('common.stop')}
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
        <div className="hint">{t('prompt.hint', { paste: PASTE_SHORTCUT })}</div>
      </div>
    </div>
  );
}

function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}
