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
  ToolCallContent,
  ToolCallStatus,
  ToolLocation,
  UpdateState,
} from '@shared/ipc';

const api = window.easycode;

// ── view models ────────────────────────────────────────────────────────────

export type ViewDensity = 'normal' | 'verbose' | 'summary';

export type PaneKind = 'chat' | 'diff' | 'plan' | 'tasks' | 'terminal' | 'file';

export type ChatItem =
  | { kind: 'user'; id: string; text: string; images?: string[] }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }
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
  /** Open file in the file pane. */
  openFile?: { path: string; content: string };
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
  rewindTo: (id: string, beforeUserMessageIndex: number) => Promise<void>;
  respondPermission: (
    requestId: string,
    optionId: string | null,
    answers?: AskAnswersPayload,
  ) => Promise<void>;
  setDensity: (id: string, density: ViewDensity) => void;
  togglePane: (id: string, pane: PaneKind) => void;
  setActivePane: (id: string, pane: PaneKind) => void;
  refreshDiff: (id: string) => Promise<void>;
  openFile: (id: string, path: string) => Promise<void>;
  setSidebarFilter: (patch: Partial<StoreState['sidebarFilter']>) => void;
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
  sessions: {},
  order: [],
  permissionQueue: [],
  backendLog: [],
  sidebarFilter: { status: 'active', query: '' },
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
      model: model ?? defaultModelFor(get()),
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
      model: model ?? defaultModelFor(get()),
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
          [id]: { ...v, transcript: [], plan: [], draftAssistantId: undefined },
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
    }
  },

  archiveSession: async (id, archived) => {
    await api.sessions.archive(id, archived);
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
 * The model a freshly created session should default to. In custom-model-only
 * mode that's the captured custom model (otherwise the backend would fall back
 * to the cloud model, which 401s when not signed in). Signed-in users get the
 * backend default (undefined).
 */
function defaultModelFor(s: StoreState): string | undefined {
  return s.customModelOnly ? s.defaultCustomModelId : undefined;
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
      const item: ChatItem = { kind: 'assistant', id: newId(), text: event.text };
      return { ...view, transcript: [...t, item], draftAssistantId: item.id };
    }

    case 'thought_chunk': {
      const t = [...view.transcript];
      const last = t[t.length - 1];
      if (last && last.kind === 'thought') {
        t[t.length - 1] = { ...last, text: last.text + event.text };
      } else {
        t.push({ kind: 'thought', id: newId(), text: event.text });
      }
      return { ...view, transcript: t };
    }

    case 'user_chunk':
      return {
        ...view,
        transcript: [
          ...view.transcript,
          { kind: 'user', id: newId(), text: stripImageHints(event.text) },
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
