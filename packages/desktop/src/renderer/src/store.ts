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
import type {
  AcpToolKind,
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
} from '@shared/ipc';

const api = window.easycode;

// ── view models ────────────────────────────────────────────────────────────

export type ViewDensity = 'normal' | 'verbose' | 'summary';

export type PaneKind = 'chat' | 'diff' | 'plan' | 'tasks' | 'terminal' | 'file';

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
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
  sessions: Record<string, SessionView>;
  order: string[]; // session ids, newest first
  activeSessionId?: string;
  permissionQueue: PermissionRequest[];
  backendLog: string[];
  sidebarFilter: { status: 'all' | 'active' | 'archived'; query: string };

  init: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  setActive: (id: string) => void;
  createSession: (cwd: string, mode: PermissionMode, model?: string) => Promise<void>;
  resumeSession: (id: string) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  sendPrompt: (id: string, text: string, atPaths: string[]) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  setModel: (id: string, modelId: string) => Promise<void>;
  setMode: (id: string, mode: PermissionMode) => Promise<void>;
  rewindTo: (id: string, beforeUserMessageIndex: number) => Promise<void>;
  respondPermission: (requestId: string, optionId: string | null) => Promise<void>;
  setDensity: (id: string, density: ViewDensity) => void;
  togglePane: (id: string, pane: PaneKind) => void;
  setActivePane: (id: string, pane: PaneKind) => void;
  refreshDiff: (id: string) => Promise<void>;
  openFile: (id: string, path: string) => Promise<void>;
  setSidebarFilter: (patch: Partial<StoreState['sidebarFilter']>) => void;
}

/** One-time guard so `init()` wires backend IPC listeners exactly once. */
let initialized = false;

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
  sessions: {},
  order: [],
  permissionQueue: [],
  backendLog: [],
  sidebarFilter: { status: 'active', query: '' },

  init: async () => {
    // Idempotent: React StrictMode double-invokes the mount effect, and the App
    // may remount. Wiring the IPC listeners more than once would apply every
    // streamed chunk/event twice (e.g. "PONG" -> "PPONGONG"). Guard so the
    // backend subscriptions are installed exactly once per renderer.
    if (initialized) return;
    initialized = true;

    const auth = await api.auth.status();
    set({ auth });

    api.auth.onChanged((status) => set({ auth: status }));

    api.sessions.onStatus(({ sessionId, status, meta }) => {
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

    api.sessions.onEvent(({ sessionId, event }) => {
      applyEvent(set, get, sessionId, event);
    });

    api.permissions.onRequest((req) => {
      set((s) => ({ permissionQueue: [...s.permissionQueue, req] }));
    });

    api.backend.onLog((line) => {
      set((s) => ({ backendLog: [...s.backendLog.slice(-400), line] }));
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

  createSession: async (cwd, mode, model) => {
    const meta = await api.sessions.create({ cwd, permissionMode: mode, model });
    set((s) => ({
      sessions: { ...s.sessions, [meta.id]: emptyView(meta) },
      order: [meta.id, ...s.order.filter((x) => x !== meta.id)],
      activeSessionId: meta.id,
    }));
  },

  resumeSession: async (id) => {
    const view = get().sessions[id];
    const meta = await api.sessions.resume(id, view?.meta.cwd ?? '');
    set((s) => ({
      sessions: { ...s.sessions, [id]: { ...(s.sessions[id] ?? emptyView(meta)), meta } },
      activeSessionId: id,
    }));
  },

  archiveSession: async (id, archived) => {
    await api.sessions.archive(id, archived);
    await get().refreshSessions();
  },

  sendPrompt: async (id, text, atPaths) => {
    // Optimistically render the user bubble.
    set((s) => {
      const view = s.sessions[id];
      if (!view) return {};
      const item: ChatItem = { kind: 'user', id: newId(), text };
      return {
        sessions: {
          ...s.sessions,
          [id]: { ...view, transcript: [...view.transcript, item], draftAssistantId: undefined },
        },
      };
    });
    await api.sessions.prompt({ sessionId: id, text, atPaths });
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

  respondPermission: async (requestId, optionId) => {
    await api.permissions.respond(
      requestId,
      optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
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

function applyEvent(
  set: SetFn,
  get: () => StoreState,
  sessionId: string,
  event: import('@shared/ipc').DesktopSessionEvent,
): void {
  const view = get().sessions[sessionId];
  if (!view) return;

  const update = (next: Partial<SessionView>) =>
    set((s) => ({
      sessions: { ...(s as StoreState).sessions, [sessionId]: { ...(s as StoreState).sessions[sessionId], ...next } },
    }));

  switch (event.kind) {
    case 'turn_start':
      update({ draftAssistantId: undefined });
      break;

    case 'message_chunk': {
      const t = [...view.transcript];
      const last = t[t.length - 1];
      if (view.draftAssistantId && last && last.kind === 'assistant' && last.id === view.draftAssistantId) {
        t[t.length - 1] = { ...last, text: last.text + event.text };
        update({ transcript: t });
      } else {
        const item: ChatItem = { kind: 'assistant', id: newId(), text: event.text };
        update({ transcript: [...t, item], draftAssistantId: item.id });
      }
      break;
    }

    case 'thought_chunk': {
      const t = [...view.transcript];
      const last = t[t.length - 1];
      if (last && last.kind === 'thought') {
        t[t.length - 1] = { ...last, text: last.text + event.text };
      } else {
        t.push({ kind: 'thought', id: newId(), text: event.text });
      }
      update({ transcript: t });
      break;
    }

    case 'user_chunk':
      update({ transcript: [...view.transcript, { kind: 'user', id: newId(), text: event.text }] });
      break;

    case 'mode_marker':
      update({
        transcript: [...view.transcript, { kind: 'system', id: newId(), text: event.mode }],
      });
      break;

    case 'tool_call': {
      const item: ChatItem = {
        kind: 'tool',
        id: newId(),
        toolCallId: event.toolCallId,
        title: event.title,
        toolKind: event.toolKind,
        status: event.status,
        locations: event.locations,
        content: event.content ?? [],
      };
      update({ transcript: [...view.transcript, item], draftAssistantId: undefined });
      break;
    }

    case 'tool_update': {
      const t = view.transcript.map((it) => {
        if (it.kind !== 'tool' || it.toolCallId !== event.toolCallId) return it;
        return {
          ...it,
          status: event.status ?? it.status,
          title: event.title ?? it.title,
          content: event.content && event.content.length ? mergeContent(it.content, event.content) : it.content,
          terminalOutput: event.terminalOutput
            ? (it.terminalOutput ?? '') + event.terminalOutput
            : it.terminalOutput,
        };
      });
      update({ transcript: t });
      break;
    }

    case 'plan':
      update({ plan: event.entries });
      break;

    case 'usage':
      patchMeta(set, sessionId, { tokenUsed: event.used, tokenSize: event.size });
      break;

    case 'commands':
      update({ commands: event.commands });
      break;

    case 'error':
      update({ transcript: [...view.transcript, { kind: 'error', id: newId(), text: event.message }] });
      break;

    case 'turn_end':
      update({ draftAssistantId: undefined });
      // Refresh diff stats lazily after the turn settles.
      void get().refreshDiff(sessionId);
      break;
  }
}

function mergeContent(prev: ToolCallContent[], next: ToolCallContent[]): ToolCallContent[] {
  // Prefer the richest representation: keep prior diffs, append new text/diffs.
  return [...prev, ...next];
}
