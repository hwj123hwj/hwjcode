/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * The renderer's single source of truth. Holds auth, the session list, per-session
 * transcripts (built from streamed ACP events), pending permission prompts, pane
 * layout, and diffs. All backend access goes through `window.easycode`.
 */

import { create } from 'zustand';
import { type Lang, loadStoredLang, persistLang } from './i18n/i18n';
import { type ThemeMode, loadStoredTheme, persistTheme } from './theme';
import { deriveTitleFromMessage, stripImageHints } from './sessionTitle';
import type {
  AcpToolKind,
  AgentKind,
  AskAnswersPayload,
  AuthStatus,
  GitFileDiff,
  PermissionMode,
  PermissionRequest,
  PlanEntry,
  SessionMeta,
  SlashCommand,
  ThinkingMode,
  ToolCallContent,
  ToolCallStatus,
  ToolLocation,
  UpdateState,
} from '@shared/ipc';

const api = window.easycode;

// ── view models ────────────────────────────────────────────────────────────

export type ViewDensity = 'normal' | 'verbose' | 'summary';

export type PaneKind = 'chat' | 'diff' | 'plan' | 'tasks' | 'terminal' | 'file';

/**
 * Which feature the right workspace sidebar is showing (Codex-style). The bottom
 * terminal is toggled separately (it is a bottom bar, not a right-sidebar view).
 */
export type RightView = 'review' | 'browser' | 'files' | 'sidechat';

/**
 * Global workspace layout — the right feature sidebar + the bottom terminal.
 * App-level (NOT per-session) so the chosen layout survives session switches.
 * The three layout toggles + active view are persisted to localStorage; the
 * open file tabs and the side-chat session id stay in memory (paths may be
 * stale across runs, and the side chat is re-minted on demand).
 */
export interface WorkspaceUiState {
  /** Whether the left session-list sidebar is expanded (vs. collapsed). */
  sidebarOpen: boolean;
  /** Width (px) of the left session-list sidebar — user-draggable, persisted. */
  sidebarWidth: number;
  rightOpen: boolean;
  /**
   * Which feature panel is open, or `null` for "launcher" mode: the right rail
   * is shown with full labels and no content panel. Selecting a feature sets a
   * view (content shows, rail collapses to icons); re-selecting it returns here.
   */
  rightView: RightView | null;
  bottomOpen: boolean;
  /** Width (px) of the right feature sidebar — user-draggable, persisted. */
  rightWidth: number;
  /** Height (px) of the bottom terminal panel — user-draggable, persisted. */
  bottomHeight: number;
  /** Width (px) of the file explorer tree inside the Files panel — persisted. */
  fileTreeWidth: number;
  /** Absolute paths of files open in the Files panel (VSCode-style tabs). */
  fileTabs: string[];
  activeFileTab?: string;
  /** Lazily-created directory-less chat session backing the Side chat panel. */
  sideChatId?: string;
  /**
   * Built-in browser tabs (multi-tab). Each opened URL becomes/focuses a tab.
   * In-memory only (not persisted — URLs go stale across runs and webviews are
   * re-minted on demand).
   */
  browserTabs: BrowserTab[];
  activeBrowserTab?: string;
}

/** One built-in-browser tab. `url` is its current/last-navigated address. */
export interface BrowserTab {
  id: string;
  url: string;
  title?: string;
}

/** Clamp ranges for the draggable regions (kept in sync with the CSS guards). */
export const WORKSPACE_SIZE_LIMITS = {
  sidebarWidth: { min: 220, max: 480, default: 236 },
  rightWidth: { min: 340, max: 900, default: 560 },
  bottomHeight: { min: 120, max: 720, default: 300 },
  fileTreeWidth: { min: 160, max: 480, default: 240 },
} as const;

export type ChatItem =
  | { kind: 'user'; id: string; text: string; images?: string[]; timestamp?: number }
  | { kind: 'assistant'; id: string; text: string; timestamp?: number }
  | { kind: 'thought'; id: string; text: string; timestamp?: number }
  | { kind: 'system'; id: string; text: string; timestamp?: number }
  | { kind: 'error'; id: string; text: string; timestamp?: number }
  | {
      kind: 'tool';
      id: string;
      toolCallId: string;
      title: string;
      toolKind: AcpToolKind;
      status: ToolCallStatus;
      locations?: ToolLocation[];
      content: ToolCallContent[];
      terminalOutput?: string;
      rawInput?: Record<string, unknown>;
      timestamp?: number;
    };

export interface SessionView {
  meta: SessionMeta;
  transcript: ChatItem[];
  plan: PlanEntry[];
  commands: SlashCommand[];
  diffs: GitFileDiff[];
  density: ViewDensity;
  panes: PaneKind[];
  activePane: PaneKind;
  /** Whether the last transcript item is an open assistant block we append to. */
  draftAssistantId?: string;
  /**
   * True while an existing session is being resumed from disk and its prior
   * conversation is replaying (transcript was cleared, history not back yet).
   * Drives the restoring skeleton so we don't show the new-session placeholder.
   */
  restoring?: boolean;
  /** Open file in the file pane. */
  openFile?: { path: string; content: string };
  promptDraft?: string;
}

interface StoreState {
  ready: boolean;
  auth: AuthStatus | null;
  /**
   * "Custom-model-only" mode: the user chose to use the app with their own
   * custom models without signing in (mirrors the VSCode UI). When true the
   * auth gate in <App> is bypassed even though `auth.loggedIn` is false. This
   * is renderer-only state — refreshing the window resets it (the user is shown
   * the login screen again, where they can re-enter the mode in one click).
   */
  customModelOnly: boolean;
  /**
   * The `custom:…` id of the first enabled custom model, captured at init / when
   * entering custom-model mode. New sessions created while in custom-model mode
   * default to this model so they don't fall back to the cloud model (which
   * 401s when not signed in).
   */
  defaultCustomModelId?: string;
  /**
   * Monotonically-increasing counter bumped whenever a custom model is saved or
   * deleted. Components that list custom models subscribe to this value so they
   * re-fetch from disk instead of showing a stale snapshot.
   */
  customModelsRev: number;
  bumpCustomModelsRev: () => void;
  sessions: Record<string, SessionView>;
  order: string[]; // session ids, newest first
  activeSessionId?: string;
  permissionQueue: PermissionRequest[];
  backendLog: string[];
  sidebarFilter: { status: 'all' | 'active' | 'archived'; query: string };
  /** UI display language; persisted to localStorage, defaults to the OS lang. */
  lang: Lang;
  setLang: (lang: Lang) => void;
  /**
   * Color theme override; persisted to localStorage. 'system' follows the OS,
   * 'light'/'dark' force a palette. Applied to <html data-theme> by <App> (and
   * mirrored to the native window chrome via `api.theme.set`).
   */
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;

  /** Latest version-update snapshot from the main process (null until loaded). */
  update: UpdateState | null;
  /** Run a version check. `manual` ignores a prior skip (Settings button). */
  checkUpdate: (manual?: boolean) => Promise<void>;
  /** Download the available installer (progress streams in via onProgress). */
  downloadUpdate: () => Promise<void>;
  cancelUpdateDownload: () => Promise<void>;
  /** Launch the downloaded installer (DMG mount / EXE run). */
  installUpdate: () => Promise<void>;
  /** Permanently dismiss the available version. */
  skipUpdate: () => Promise<void>;
  /** Hide the banner until the next launch. */
  snoozeUpdate: () => Promise<void>;

  /**
   * Enter custom-model-only mode (bypass the login gate). Refreshes the default
   * custom model from disk first; returns false (and stays on the login screen)
   * if there is no enabled custom model to use.
   */
  enterCustomModelMode: () => Promise<boolean>;
  /** Leave custom-model-only mode (e.g. on logout / explicit sign-in switch). */
  exitCustomModelMode: () => void;

  init: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  setActive: (id: string) => void;
  /** Focus a session, transparently resuming its backend if it isn't live. */
  focusSession: (id: string) => void;
  createSession: (
    cwd: string,
    mode: PermissionMode,
    agentType?: AgentKind,
    model?: string,
  ) => Promise<void>;
  /** Start a directory-less "just chat" session (Chats section). Returns its id. */
  createChatSession: (
    mode?: PermissionMode,
    agentType?: AgentKind,
    model?: string,
  ) => Promise<string>;
  resumeSession: (id: string) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  /** Permanently delete a session (irreversible). Drops it from the store too. */
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  sendPrompt: (
    id: string,
    text: string,
    atPaths: string[],
    images?: { mimeType: string; data: string }[],
  ) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  setModel: (id: string, modelId: string) => Promise<void>;
  setMode: (id: string, mode: PermissionMode) => Promise<void>;
  setThinking: (id: string, thinking: ThinkingMode) => Promise<void>;
  rewindTo: (id: string, beforeUserMessageIndex: number) => Promise<void>;
  respondPermission: (
    requestId: string,
    optionId: string | null,
    answers?: AskAnswersPayload,
  ) => Promise<void>;
  setDensity: (id: string, density: ViewDensity) => void;
  setPromptDraft: (id: string, text: string | undefined) => void;
  togglePane: (id: string, pane: PaneKind) => void;
  setActivePane: (id: string, pane: PaneKind) => void;
  refreshDiff: (id: string) => Promise<void>;
  openFile: (id: string, path: string) => Promise<void>;
  setSidebarFilter: (patch: Partial<StoreState['sidebarFilter']>) => void;

  // ── workspace layout (Codex-style right sidebar + bottom terminal) ────────
  workspace: WorkspaceUiState;
  /** Expand/collapse the left session-list sidebar. */
  toggleSidebar: () => void;
  /** Show/hide the right feature sidebar (rail + content panel). */
  toggleWorkspaceRight: () => void;
  /** Show/hide the bottom terminal panel. */
  toggleWorkspaceBottom: () => void;
  /** Reveal the right sidebar on a specific feature view. */
  openWorkspaceView: (view: RightView) => void;
  /**
   * Open a URL in the built-in browser: focuses an existing tab with the same
   * URL, otherwise opens a new tab. Reveals the browser view.
   */
  openInBrowser: (url: string) => void;
  /** Open a fresh blank browser tab. */
  newBrowserTab: () => void;
  closeBrowserTab: (id: string) => void;
  setActiveBrowserTab: (id: string) => void;
  /** Update a tab's current url/title (from webview navigation events). */
  updateBrowserTab: (id: string, patch: Partial<Omit<BrowserTab, 'id'>>) => void;
  /** Transient right-click menu for a URL in the transcript (null = closed). */
  linkMenu: { url: string; x: number; y: number } | null;
  openLinkMenu: (url: string, x: number, y: number) => void;
  closeLinkMenu: () => void;
  /**
   * Resize one of the draggable regions (right sidebar / bottom terminal / file
   * tree). The value is clamped to the region's limits and persisted.
   */
  setWorkspaceSize: (key: keyof typeof WORKSPACE_SIZE_LIMITS, value: number) => void;
  /** Open a file in the Files panel: add a tab, focus it, reveal the panel. */
  openFileTab: (path: string) => void;
  closeFileTab: (path: string) => void;
  setActiveFileTab: (path: string) => void;
  /** Remember the lazily-created side-chat session id. */
  setSideChatId: (id: string) => void;
}

/**
 * Workspace layout is persisted (just the three toggles + the active view) so a
 * relaunch restores the user's Codex-style layout. File tabs / side-chat id are
 * intentionally not persisted.
 */
const WORKSPACE_KEY = 'easycode.workspace';

/** Clamp a persisted size into its allowed range, falling back to the default. */
function clampSize(v: unknown, key: keyof typeof WORKSPACE_SIZE_LIMITS): number {
  const { min, max, default: dflt } = WORKSPACE_SIZE_LIMITS[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, v));
}

function loadWorkspaceUi(): WorkspaceUiState {
  const base: WorkspaceUiState = {
    sidebarOpen: true,
    sidebarWidth: WORKSPACE_SIZE_LIMITS.sidebarWidth.default,
    rightOpen: false,
    rightView: null,
    bottomOpen: false,
    rightWidth: WORKSPACE_SIZE_LIMITS.rightWidth.default,
    bottomHeight: WORKSPACE_SIZE_LIMITS.bottomHeight.default,
    fileTreeWidth: WORKSPACE_SIZE_LIMITS.fileTreeWidth.default,
    fileTabs: [],
    browserTabs: [],
  };
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<WorkspaceUiState>;
      return {
        ...base,
        // Default the sidebar to open when the key was never persisted.
        sidebarOpen: p.sidebarOpen ?? true,
        sidebarWidth: clampSize(p.sidebarWidth, 'sidebarWidth'),
        rightOpen: !!p.rightOpen,
        rightView: p.rightView ?? null,
        bottomOpen: !!p.bottomOpen,
        rightWidth: clampSize(p.rightWidth, 'rightWidth'),
        bottomHeight: clampSize(p.bottomHeight, 'bottomHeight'),
        fileTreeWidth: clampSize(p.fileTreeWidth, 'fileTreeWidth'),
      };
    }
  } catch {
    /* localStorage unavailable / malformed — fall through to defaults */
  }
  return base;
}

function persistWorkspaceUi(w: WorkspaceUiState): void {
  try {
    localStorage.setItem(
      WORKSPACE_KEY,
      JSON.stringify({
        sidebarOpen: w.sidebarOpen,
        sidebarWidth: w.sidebarWidth,
        rightOpen: w.rightOpen,
        rightView: w.rightView,
        bottomOpen: w.bottomOpen,
        rightWidth: w.rightWidth,
        bottomHeight: w.bottomHeight,
        fileTreeWidth: w.fileTreeWidth,
      }),
    );
  } catch {
    /* best-effort */
  }
}

/** One-time guard so `init()` wires backend IPC listeners exactly once. */
let initialized = false;

/**
 * Session ids that currently have a live backend bridge in the main process
 * THIS app run. Sessions restored from disk on startup are NOT here until the
 * user opens them (which resumes them). Used to decide whether a click should
 * resume (spawn the backend + replay history) or just focus an already-running
 * session. A module-level set (not store state) since it is per-renderer-run and
 * never rendered. Cleared naturally on app restart.
 */
const liveSessions = new Set<string>();

/**
 * Sessions whose resume (backend spawn + history replay) is currently in flight.
 * Resuming the SAME session twice would spawn a second backend that replays the
 * whole history again — doubling the event flood that already strains the
 * renderer. Guard so rapid re-clicks while a resume is pending are no-ops.
 */
const resumingSessions = new Set<string>();

const newId = (() => {
  let n = 0;
  return () => `r${Date.now().toString(36)}-${(n++).toString(36)}`;
})();

function emptyView(meta: SessionMeta): SessionView {
  return {
    meta,
    transcript: [],
    plan: [],
    commands: [],
    diffs: [],
    density: 'normal',
    panes: ['chat'],
    activePane: 'chat',
  };
}

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  auth: null,
  customModelOnly: false,
  defaultCustomModelId: undefined,
  customModelsRev: 0,
  bumpCustomModelsRev: () => set((s) => ({ customModelsRev: s.customModelsRev + 1 })),
  sessions: {},
  order: [],
  permissionQueue: [],
  backendLog: [],
  sidebarFilter: { status: 'active', query: '' },
  linkMenu: null,
  workspace: loadWorkspaceUi(),
  lang: loadStoredLang(),
  setLang: (lang) => {
    persistLang(lang);
    set({ lang });
  },
  theme: loadStoredTheme(),
  setTheme: (theme) => {
    persistTheme(theme);
    set({ theme });
  },

  update: null,
  checkUpdate: async (manual) => {
    const res = await api.updater.check(!!manual);
    set({ update: res.state });
  },
  downloadUpdate: async () => {
    const state = await api.updater.download();
    set({ update: state });
  },
  cancelUpdateDownload: async () => {
    await api.updater.cancelDownload();
  },
  installUpdate: async () => {
    await api.updater.install();
  },
  skipUpdate: async () => {
    const v = get().update?.info?.version;
    if (v) await api.updater.skip(v);
  },
  snoozeUpdate: async () => {
    await api.updater.snooze();
  },

  enterCustomModelMode: async () => {
    const id = await firstEnabledCustomModelId();
    if (!id) return false; // nothing usable — keep the user on the login screen
    set({ customModelOnly: true, defaultCustomModelId: id });
    return true;
  },

  exitCustomModelMode: () => set({ customModelOnly: false }),

  init: async () => {
    // Idempotent: React StrictMode double-invokes the mount effect, and the App
    // may remount. Wiring the IPC listeners more than once would apply every
    // streamed chunk/event twice (e.g. "PONG" -> "PPONGONG"). Guard so the
    // backend subscriptions are installed exactly once per renderer.
    if (initialized) return;
    initialized = true;

    const auth = await api.auth.status();
    set({ auth });

    // Capture the default custom model up front so custom-model-only mode (and
    // the first session it creates) can use it without another disk read.
    set({ defaultCustomModelId: await firstEnabledCustomModelId() });

    api.auth.onChanged((status) => set({ auth: status }));

    api.sessions.onStatus(({ sessionId, status, meta }) => {
      // A backend that exited no longer has a live bridge — drop it so the next
      // click resumes (respawns + replays) instead of just focusing.
      if (status === 'exited') liveSessions.delete(sessionId);
      set((s) => {
        const view = s.sessions[sessionId];
        if (!view) return {};
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...view,
              meta: { ...view.meta, ...meta, status },
            },
          },
        };
      });
    });

    // Coalesce streamed session events. On resume the backend replays the FULL
    // prior conversation as a burst of session updates; applying each one with
    // its own `set` re-rendered the entire transcript (and the sidebar) once per
    // event — O(n²) over a long history, which pinned the renderer thread and
    // showed as a frozen white screen after clicking a session. We now buffer
    // events and flush them in a single `set` per ~frame, so a replay of N
    // events costs a handful of renders instead of N.
    api.sessions.onEvent(({ sessionId, event }) => {
      bufferEvent(set, get, sessionId, event);
    });

    api.permissions.onRequest((req) => {
      set((s) => ({ permissionQueue: [...s.permissionQueue, req] }));
    });

    // A turn-complete notification was clicked: bring that session to the front
    // (resuming its backend if it isn't live), exactly like a sidebar click.
    api.sessions.onFocusRequest((sessionId) => {
      get().focusSession(sessionId);
    });

    // The tray "New Chat" item was clicked: drop back to the default empty chat
    // page (the centered composer shown when no session is active) rather than
    // auto-creating a session — letting the user decide when to actually start
    // one keeps the click instant (no backend spawn on the click path).
    api.sessions.onNewChatRequest(() => {
      set({ activeSessionId: undefined });
    });

    api.backend.onLog((line) => {
      set((s) => ({ backendLog: [...s.backendLog.slice(-400), line] }));
    });

    // Version updates: seed the initial snapshot, then track main-process state
    // changes (check result / download done / error) and live download progress.
    api.updater
      .getState()
      .then((u) => set({ update: u }))
      .catch(() => undefined);
    api.updater.onStatus((u) => set({ update: u }));
    api.updater.onProgress((progress) => {
      set((s) => (s.update ? { update: { ...s.update, progress } } : {}));
    });

    await get().refreshSessions();
    set({ ready: true });
  },

  refreshSessions: async () => {
    const metas = await api.sessions.list();
    set((s) => {
      const sessions: Record<string, SessionView> = {};
      for (const meta of metas) {
        sessions[meta.id] = s.sessions[meta.id]
          ? { ...s.sessions[meta.id], meta }
          : emptyView(meta);
      }
      return { sessions, order: metas.map((m) => m.id) };
    });
  },

  setActive: (id) => set({ activeSessionId: id }),

  focusSession: (id) => {
    get().setActive(id);
    // Restored (or crashed) sessions have no live bridge in the main process —
    // resume to (re)spawn the backend and replay history. resumeSession is the
    // single resume path (it also resets the transcript before replay). Skip if
    // a resume for this session is already in flight (rapid re-clicks).
    if (!liveSessions.has(id) && !resumingSessions.has(id)) void get().resumeSession(id);
  },

  createSession: async (cwd, mode, agentType, model) => {
    const meta = await api.sessions.create({
      cwd,
      permissionMode: mode,
      agentType,
      model: await resolveDefaultModel(get(), model),
    });
    liveSessions.add(meta.id);
    set((s) => ({
      sessions: { ...s.sessions, [meta.id]: emptyView(meta) },
      order: [meta.id, ...s.order.filter((x) => x !== meta.id)],
      activeSessionId: meta.id,
    }));
  },

  createChatSession: async (mode, agentType, model) => {
    const meta = await api.sessions.createChat({
      permissionMode: mode ?? 'default',
      agentType,
      model: await resolveDefaultModel(get(), model),
    });
    liveSessions.add(meta.id);
    set((s) => ({
      sessions: { ...s.sessions, [meta.id]: emptyView(meta) },
      order: [meta.id, ...s.order.filter((x) => x !== meta.id)],
      activeSessionId: meta.id,
    }));
    return meta.id;
  },

  resumeSession: async (id) => {
    if (resumingSessions.has(id)) return; // already resuming — avoid a double spawn/replay
    resumingSessions.add(id);
    // loadSession replays the FULL prior conversation via session updates, so
    // clear the transcript/plan first — otherwise a re-resume (e.g. after the
    // backend exited) would append a second copy on top of the existing one.
    // Also drop any buffered events for this id so a stale replay tail can't
    // land on the freshly-cleared transcript.
    pendingEvents.delete(id);
    set((s) => {
      const v = s.sessions[id];
      if (!v) return { activeSessionId: id };
      return {
        sessions: {
          ...s.sessions,
          [id]: { ...v, transcript: [], plan: [], draftAssistantId: undefined, restoring: true },
        },
        activeSessionId: id,
      };
    });
    try {
      const view = get().sessions[id];
      const meta = await api.sessions.resume(id, view?.meta.cwd ?? '');
      liveSessions.add(id);
      set((s) => ({
        sessions: { ...s.sessions, [id]: { ...(s.sessions[id] ?? emptyView(meta)), meta } },
        activeSessionId: id,
      }));
    } finally {
      resumingSessions.delete(id);
      // Replay has been kicked off; clear the restoring flag. The skeleton stays
      // until then OR until the first replayed item lands (whichever comes first,
      // since the skeleton is also gated on an empty transcript).
      set((s) => {
        const v = s.sessions[id];
        return v ? { sessions: { ...s.sessions, [id]: { ...v, restoring: false } } } : {};
      });
    }
  },

  archiveSession: async (id, archived) => {
    await api.sessions.archive(id, archived);
    await get().refreshSessions();
  },

  deleteSession: async (id) => {
    await api.sessions.delete(id);
    liveSessions.delete(id);
    resumingSessions.delete(id);
    pendingEvents.delete(id);
    // Drop it locally up front so the row disappears immediately, then clear the
    // active selection if it was the deleted session.
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return {
        sessions,
        order: s.order.filter((x) => x !== id),
        activeSessionId: s.activeSessionId === id ? undefined : s.activeSessionId,
      };
    });
    await get().refreshSessions();
  },

  renameSession: async (id, title) => {
    const meta = await api.sessions.rename(id, title);
    patchMeta(set, id, { title: meta.title });
  },

  sendPrompt: async (id, text, atPaths, images) => {
    // First user message → derive a provisional sidebar title from it (front-end
    // only; the backend may later refine it via [TITLE_UPDATE]). Detected before
    // we push the optimistic bubble, so "no user bubble yet" means "first turn".
    const viewBefore = get().sessions[id];
    const isFirstUserMessage =
      !!viewBefore && !viewBefore.transcript.some((i) => i.kind === 'user');
    if (isFirstUserMessage) {
      const provisional = deriveTitleFromMessage(text);
      if (provisional) {
        // Optimistic local patch so the sidebar updates instantly; the main
        // process persists + echoes back via sessionStatus (no lock).
        patchMeta(set, id, { title: provisional });
        api.sessions.setTitleProvisional(id, provisional).catch(() => undefined);
      }
    }

    // Optimistically render the user bubble. We send `text` (which may carry the
    // backend-only "[IMAGE: name (path)]" hints for image_reader) to the backend
    // verbatim, but the bubble shows the user's words with those hints stripped
    // plus the real image thumbnails (inlined as data URLs from `images`).
    set((s) => {
      const view = s.sessions[id];
      if (!view) return {};
      const displayImages = (images ?? []).map((im) => `data:${im.mimeType};base64,${im.data}`);
      const item: ChatItem = {
        kind: 'user',
        id: newId(),
        text: stripImageHints(text),
        images: displayImages.length ? displayImages : undefined,
        timestamp: Date.now(),
      };
      return {
        sessions: {
          ...s.sessions,
          [id]: { ...view, transcript: [...view.transcript, item], draftAssistantId: undefined },
        },
      };
    });
    await api.sessions.prompt({ sessionId: id, text, atPaths, images });
  },

  cancel: async (id) => {
    await api.sessions.cancel(id);
  },

  setModel: async (id, modelId) => {
    await api.sessions.setModel(id, modelId);
    patchMeta(set, id, { model: modelId });
  },

  setMode: async (id, mode) => {
    await api.sessions.setMode(id, mode);
    patchMeta(set, id, { permissionMode: mode });
  },

  setThinking: async (id, thinking) => {
    await api.sessions.setThinking(id, thinking);
    patchMeta(set, id, { thinking });
  },

  rewindTo: async (id, beforeUserMessageIndex) => {
    await api.sessions.rewind(id, beforeUserMessageIndex);
    // Drop transcript items at/after the targeted user message locally.
    set((s) => {
      const view = s.sessions[id];
      if (!view) return {};
      let seen = 0;
      let cut = view.transcript.length;
      for (let i = 0; i < view.transcript.length; i++) {
        if (view.transcript[i].kind === 'user') {
          if (seen === beforeUserMessageIndex) {
            cut = i;
            break;
          }
          seen++;
        }
      }
      return {
        sessions: {
          ...s.sessions,
          [id]: { ...view, transcript: view.transcript.slice(0, cut), draftAssistantId: undefined },
        },
      };
    });
  },

  respondPermission: async (requestId, optionId, answers) => {
    await api.permissions.respond(
      requestId,
      optionId
        ? { outcome: 'selected', optionId, ...(answers ? { answers } : {}) }
        : { outcome: 'cancelled' },
    );
    set((s) => ({ permissionQueue: s.permissionQueue.filter((r) => r.requestId !== requestId) }));
  },

  setDensity: (id, density) => updateView(set, id, (v) => ({ ...v, density })),

  setPromptDraft: (id, text) => updateView(set, id, (v) => ({ ...v, promptDraft: text })),

  togglePane: (id, pane) =>
    updateView(set, id, (v) => {
      const has = v.panes.includes(pane);
      const panes = has ? v.panes.filter((p) => p !== pane) : [...v.panes, pane];
      return { ...v, panes: panes.length ? panes : ['chat'], activePane: has ? v.activePane : pane };
    }),

  setActivePane: (id, pane) => updateView(set, id, (v) => ({ ...v, activePane: pane })),

  refreshDiff: async (id) => {
    const view = get().sessions[id];
    if (!view) return;
    const diffs = await api.workspace.gitDiff(view.meta.cwd, id);
    updateView(set, id, (v) => ({ ...v, diffs }));
  },

  openFile: async (id, path) => {
    const content = await api.workspace.readFile(path).catch(() => '');
    updateView(set, id, (v) => ({ ...v, openFile: { path, content }, activePane: 'file' }));
  },

  setSidebarFilter: (patch) =>
    set((s) => ({ sidebarFilter: { ...s.sidebarFilter, ...patch } })),

  // ── workspace layout ───────────────────────────────────────────────────────
  toggleSidebar: () =>
    set((s) => {
      const workspace = { ...s.workspace, sidebarOpen: !s.workspace.sidebarOpen };
      persistWorkspaceUi(workspace);
      return { workspace };
    }),

  toggleWorkspaceRight: () =>
    set((s) => {
      const workspace = { ...s.workspace, rightOpen: !s.workspace.rightOpen };
      persistWorkspaceUi(workspace);
      return { workspace };
    }),

  toggleWorkspaceBottom: () =>
    set((s) => {
      const workspace = { ...s.workspace, bottomOpen: !s.workspace.bottomOpen };
      persistWorkspaceUi(workspace);
      return { workspace };
    }),

  setWorkspaceSize: (key, value) =>
    set((s) => {
      const workspace = { ...s.workspace, [key]: clampSize(value, key) };
      persistWorkspaceUi(workspace);
      return { workspace };
    }),

  openWorkspaceView: (view) =>
    set((s) => {
      // Selecting the currently-open feature returns to "launcher" mode (rail
      // expands with labels, content panel hides) without fully closing the
      // sidebar — the top-right toggle is the way to hide it entirely. Selecting
      // any other feature opens it (content shows, rail collapses to icons).
      const same = s.workspace.rightOpen && s.workspace.rightView === view;
      const workspace = same
        ? { ...s.workspace, rightView: null }
        : { ...s.workspace, rightOpen: true, rightView: view };
      persistWorkspaceUi(workspace);
      return { workspace };
    }),

  openInBrowser: (url) =>
    set((s) => {
      const tabs = s.workspace.browserTabs;
      const existing = tabs.find((t) => t.url === url);
      const browserTabs = existing ? tabs : [...tabs, { id: newId(), url }];
      const activeBrowserTab = existing ? existing.id : browserTabs[browserTabs.length - 1].id;
      const workspace: WorkspaceUiState = {
        ...s.workspace,
        rightOpen: true,
        rightView: 'browser',
        browserTabs,
        activeBrowserTab,
      };
      // Tabs are in-memory; persistWorkspaceUi only saves the layout keys.
      persistWorkspaceUi(workspace);
      return { workspace };
    }),

  newBrowserTab: () =>
    set((s) => {
      const id = newId();
      const workspace: WorkspaceUiState = {
        ...s.workspace,
        rightOpen: true,
        rightView: 'browser',
        browserTabs: [...s.workspace.browserTabs, { id, url: '' }],
        activeBrowserTab: id,
      };
      persistWorkspaceUi(workspace);
      return { workspace };
    }),

  closeBrowserTab: (id) =>
    set((s) => {
      const browserTabs = s.workspace.browserTabs.filter((t) => t.id !== id);
      let activeBrowserTab = s.workspace.activeBrowserTab;
      if (activeBrowserTab === id) {
        const idx = s.workspace.browserTabs.findIndex((t) => t.id === id);
        activeBrowserTab = browserTabs[Math.min(idx, browserTabs.length - 1)]?.id;
      }
      return { workspace: { ...s.workspace, browserTabs, activeBrowserTab } };
    }),

  setActiveBrowserTab: (id) =>
    set((s) => ({ workspace: { ...s.workspace, activeBrowserTab: id } })),

  updateBrowserTab: (id, patch) =>
    set((s) => ({
      workspace: {
        ...s.workspace,
        browserTabs: s.workspace.browserTabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      },
    })),

  openLinkMenu: (url, x, y) => set({ linkMenu: { url, x, y } }),
  closeLinkMenu: () => set({ linkMenu: null }),

  openFileTab: (path) =>
    set((s) => {
      const fileTabs = s.workspace.fileTabs.includes(path)
        ? s.workspace.fileTabs
        : [...s.workspace.fileTabs, path];
      const workspace: WorkspaceUiState = {
        ...s.workspace,
        fileTabs,
        activeFileTab: path,
        rightOpen: true,
        rightView: 'files',
      };
      persistWorkspaceUi(workspace);
      return { workspace };
    }),

  closeFileTab: (path) =>
    set((s) => {
      const fileTabs = s.workspace.fileTabs.filter((p) => p !== path);
      // When closing the active tab, fall back to the neighbour (or none).
      let activeFileTab = s.workspace.activeFileTab;
      if (activeFileTab === path) {
        const idx = s.workspace.fileTabs.indexOf(path);
        activeFileTab = fileTabs[Math.min(idx, fileTabs.length - 1)];
      }
      return { workspace: { ...s.workspace, fileTabs, activeFileTab } };
    }),

  setActiveFileTab: (path) =>
    set((s) => ({ workspace: { ...s.workspace, activeFileTab: path } })),

  setSideChatId: (id) => set((s) => ({ workspace: { ...s.workspace, sideChatId: id } })),
}));

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * The `custom:…` id of the first enabled custom model, or undefined if there
 * are none. Used to (a) decide whether custom-model-only mode is even possible
 * and (b) pick the default model for sessions created in that mode.
 */
async function firstEnabledCustomModelId(): Promise<string | undefined> {
  try {
    const models = await api.models.listCustom();
    return models.find((m) => m.enabled !== false)?.id;
  } catch {
    return undefined;
  }
}

/**
 * The model a freshly created session should default to. Priority:
 *   1. an explicit `model` passed by the caller (a picker selection),
 *   2. the user's global default-model setting (`~/.easycode-user/settings.json`),
 *      so they don't have to choose a model on every new session,
 *   3. in custom-model-only mode, the captured custom model — otherwise the
 *      backend falls back to the cloud model, which 401s when not signed in.
 * Resolving to `undefined` lets the backend pick its own default.
 *
 * When not signed in (custom-model-only mode) the cloud models are unusable, so
 * a global default is only honoured there if it's itself a custom model.
 */
async function resolveDefaultModel(s: StoreState, explicit?: string): Promise<string | undefined> {
  if (explicit !== undefined) return explicit;
  let globalDefault: string | undefined;
  try {
    globalDefault = (await api.settings.get()).defaultModel?.trim() || undefined;
  } catch {
    /* settings unreadable — fall back below */
  }
  if (s.customModelOnly) {
    // Always read from disk so adds/deletes after app start are reflected
    // immediately — the cached defaultCustomModelId may be stale.
    const liveCustomId = await firstEnabledCustomModelId();
    if (globalDefault?.startsWith('custom:')) {
      const all = await api.models.listCustom().catch(() => []);
      const still = all.some((m) => m.id === globalDefault && m.enabled !== false);
      return still ? globalDefault : liveCustomId;
    }
    return liveCustomId;
  }
  // Signed-in path: validate any saved custom: default still exists.
  if (globalDefault?.startsWith('custom:')) {
    const all = await api.models.listCustom().catch(() => []);
    const still = all.some((m) => m.id === globalDefault && m.enabled !== false);
    if (!still) return undefined; // deleted — let backend pick
  }
  return globalDefault;
}

type SetFn = (
  partial:
    | StoreState
    | Partial<StoreState>
    | ((state: StoreState) => StoreState | Partial<StoreState>),
) => void;

function updateView(set: SetFn, id: string, fn: (v: SessionView) => SessionView): void {
  set((s) => {
    const view = (s as StoreState).sessions[id];
    if (!view) return {};
    return { sessions: { ...(s as StoreState).sessions, [id]: fn(view) } };
  });
}

function patchMeta(set: SetFn, id: string, patch: Partial<SessionMeta>): void {
  updateView(set, id, (v) => ({ ...v, meta: { ...v.meta, ...patch } }));
}

type DesktopSessionEvent = import('@shared/ipc').DesktopSessionEvent;

// ── streamed-event buffering ───────────────────────────────────────────────
//
// Backend session updates (live streaming AND the full-history replay on
// resume) are buffered here and flushed in a single `set` per ~frame. This
// keeps a replay of thousands of events from re-rendering the whole transcript
// once per event — the cause of the post-click freeze/white screen.

const pendingEvents = new Map<string, DesktopSessionEvent[]>();
let flushHandle: ReturnType<typeof setTimeout> | null = null;

function bufferEvent(
  set: SetFn,
  get: () => StoreState,
  sessionId: string,
  event: DesktopSessionEvent,
): void {
  let arr = pendingEvents.get(sessionId);
  if (!arr) {
    arr = [];
    pendingEvents.set(sessionId, arr);
  }
  arr.push(event);
  if (flushHandle == null) {
    flushHandle = setTimeout(() => {
      flushHandle = null;
      const batch = [...pendingEvents.entries()];
      pendingEvents.clear();
      for (const [sid, events] of batch) flushEvents(set, get, sid, events);
    }, 16);
  }
}

/** Apply a batch of buffered events for one session in a single store update. */
function flushEvents(
  set: SetFn,
  get: () => StoreState,
  sessionId: string,
  events: DesktopSessionEvent[],
): void {
  let needsDiffRefresh = false;
  set((s) => {
    const cur = (s as StoreState).sessions[sessionId];
    if (!cur) return {};
    let view = cur;
    for (const event of events) {
      view = reduceEvent(view, event);
      if (event.kind === 'turn_end') needsDiffRefresh = true;
    }
    return { sessions: { ...(s as StoreState).sessions, [sessionId]: view } };
  });
  // Refresh diff stats lazily after the turn(s) settle — once per flush.
  if (needsDiffRefresh) void get().refreshDiff(sessionId);
}

/** Pure-ish reducer: fold one streamed event into a session view. */
function reduceEvent(view: SessionView, event: DesktopSessionEvent): SessionView {
  switch (event.kind) {
    case 'turn_start':
      return { ...view, draftAssistantId: undefined };

    case 'message_chunk': {
      const t = [...view.transcript];
      const last = t[t.length - 1];
      if (view.draftAssistantId && last && last.kind === 'assistant' && last.id === view.draftAssistantId) {
        t[t.length - 1] = { ...last, text: last.text + event.text };
        return { ...view, transcript: t };
      }
      const item: ChatItem = { kind: 'assistant', id: newId(), text: event.text, timestamp: Date.now() };
      return { ...view, transcript: [...t, item], draftAssistantId: item.id };
    }

    case 'thought_chunk': {
      const t = [...view.transcript];
      const last = t[t.length - 1];
      if (last && last.kind === 'thought') {
        t[t.length - 1] = { ...last, text: last.text + event.text };
      } else {
        t.push({ kind: 'thought', id: newId(), text: event.text, timestamp: Date.now() });
      }
      return { ...view, transcript: t };
    }

    case 'user_chunk':
      return {
        ...view,
        transcript: [
          ...view.transcript,
          { kind: 'user', id: newId(), text: stripImageHints(event.text), timestamp: Date.now() },
        ],
      };

    case 'mode_marker':
      return {
        ...view,
        transcript: [...view.transcript, { kind: 'system', id: newId(), text: event.mode }],
      };

    case 'tool_call': {
      // Idempotent on toolCallId: a backend may re-announce a call (e.g. a
      // streaming proxy replaying the cumulative candidate). Refresh the
      // existing row in place rather than appending a duplicate.
      const exists = view.transcript.some(
        (it) => it.kind === 'tool' && it.toolCallId === event.toolCallId,
      );
      if (exists) {
        const t = view.transcript.map((it) => {
          if (it.kind !== 'tool' || it.toolCallId !== event.toolCallId) return it;
          return {
            ...it,
            title: event.title,
            toolKind: event.toolKind,
            status: event.status,
            locations: event.locations,
            rawInput: event.rawInput,
            content: event.content && event.content.length ? event.content : it.content,
          };
        });
        return { ...view, transcript: t, draftAssistantId: undefined };
      }
      const item: ChatItem = {
        kind: 'tool',
        id: newId(),
        toolCallId: event.toolCallId,
        title: event.title,
        toolKind: event.toolKind,
        status: event.status,
        locations: event.locations,
        content: event.content ?? [],
        rawInput: event.rawInput,
      };
      return { ...view, transcript: [...view.transcript, item], draftAssistantId: undefined };
    }

    case 'tool_update': {
      const t = view.transcript.map((it) => {
        if (it.kind !== 'tool' || it.toolCallId !== event.toolCallId) return it;
        return {
          ...it,
          status: event.status ?? it.status,
          title: event.title ?? it.title,
          content:
            event.content && event.content.length ? mergeContent(it.content, event.content) : it.content,
          terminalOutput: event.terminalOutput
            ? (it.terminalOutput ?? '') + event.terminalOutput
            : it.terminalOutput,
        };
      });
      return { ...view, transcript: t };
    }

    case 'plan':
      return { ...view, plan: event.entries };

    case 'usage':
      return { ...view, meta: { ...view.meta, tokenUsed: event.used, tokenSize: event.size } };

    case 'commands':
      return { ...view, commands: event.commands };

    case 'error':
      return {
        ...view,
        transcript: [...view.transcript, { kind: 'error', id: newId(), text: event.message }],
      };

    case 'turn_end':
      return { ...view, draftAssistantId: undefined };

    default:
      return view;
  }
}

function mergeContent(prev: ToolCallContent[], next: ToolCallContent[]): ToolCallContent[] {
  // Prefer the richest representation: keep prior diffs, append new text/diffs.
  return [...prev, ...next];
}
