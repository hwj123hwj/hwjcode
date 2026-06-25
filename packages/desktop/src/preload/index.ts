/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * The preload bridge. Exposes a typed, minimal `window.easycode` surface to the
 * renderer over contextIsolation — the renderer never sees ipcRenderer or Node.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IpcEvent, IpcInvoke } from '../shared/ipc.js';
import type {
  ApiKeyLoginResult,
  AuthStatus,
  BrowserLoginResult,
  ComputerUseStatus,
  CreateSessionOptions,
  CustomModelEntry,
  CustomModelInput,
  DesktopUserSettings,
  DetectedIde,
  DirEntry,
  EasycodeBridge,
  ExternalAgentAvailability,
  FeishuDomain,
  FeishuExternalProcess,
  FeishuLobby,
  FeishuManualInput,
  FeishuQrBegin,
  FeishuQrBeginResult,
  FeishuResult,
  FeishuStatus,
  FileBase64,
  GitFileDiff,
  PermissionMode,
  PickedFile,
  PermissionRequest,
  PermissionResponse,
  PromptOptions,
  RewindResult,
  SaveCustomModelResult,
  SessionEventEnvelope,
  SessionMeta,
  SessionStatusEnvelope,
  ShellOption,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalHandle,
  ThemeMode,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateState,
} from '../shared/ipc.js';

/** Subscribe to a push channel; returns an unsubscribe fn. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: EasycodeBridge = {
  auth: {
    status: () => ipcRenderer.invoke(IpcInvoke.AuthStatus) as Promise<AuthStatus>,
    loginApiKey: (apiKey) =>
      ipcRenderer.invoke(IpcInvoke.AuthLoginApiKey, apiKey) as Promise<ApiKeyLoginResult>,
    loginBrowser: () =>
      ipcRenderer.invoke(IpcInvoke.AuthLoginBrowser) as Promise<BrowserLoginResult>,
    cancelBrowserLogin: () => ipcRenderer.invoke(IpcInvoke.AuthCancelBrowser) as Promise<void>,
    logout: () => ipcRenderer.invoke(IpcInvoke.AuthLogout) as Promise<void>,
    onChanged: (cb) => on<AuthStatus>(IpcEvent.AuthChanged, cb),
  },
  sessions: {
    list: () => ipcRenderer.invoke(IpcInvoke.SessionList) as Promise<SessionMeta[]>,
    create: (opts: CreateSessionOptions) =>
      ipcRenderer.invoke(IpcInvoke.SessionCreate, opts) as Promise<SessionMeta>,
    createChat: (opts?: Omit<CreateSessionOptions, 'cwd'>) =>
      ipcRenderer.invoke(IpcInvoke.SessionCreateChat, opts) as Promise<SessionMeta>,
    resume: (id, cwd) => ipcRenderer.invoke(IpcInvoke.SessionResume, id, cwd) as Promise<SessionMeta>,
    close: (id) => ipcRenderer.invoke(IpcInvoke.SessionClose, id) as Promise<void>,
    archive: (id, archived) =>
      ipcRenderer.invoke(IpcInvoke.SessionArchive, id, archived) as Promise<void>,
    delete: (id) => ipcRenderer.invoke(IpcInvoke.SessionDelete, id) as Promise<void>,
    rename: (id, title) =>
      ipcRenderer.invoke(IpcInvoke.SessionRename, id, title) as Promise<SessionMeta>,
    setTitleProvisional: (id, title) =>
      ipcRenderer.invoke(IpcInvoke.SessionSetTitleProvisional, id, title) as Promise<SessionMeta>,
    prompt: (opts: PromptOptions) => ipcRenderer.invoke(IpcInvoke.SessionPrompt, opts) as Promise<void>,
    cancel: (id) => ipcRenderer.invoke(IpcInvoke.SessionCancel, id) as Promise<void>,
    setModel: (id, modelId) =>
      ipcRenderer.invoke(IpcInvoke.SessionSetModel, id, modelId) as Promise<void>,
    setMode: (id, mode: PermissionMode) =>
      ipcRenderer.invoke(IpcInvoke.SessionSetMode, id, mode) as Promise<void>,
    rewind: (id, idx) => ipcRenderer.invoke(IpcInvoke.SessionRewind, id, idx) as Promise<RewindResult>,
    onEvent: (cb) => on<SessionEventEnvelope>(IpcEvent.SessionEvent, cb),
    onStatus: (cb) => on<SessionStatusEnvelope>(IpcEvent.SessionStatus, cb),
    onFocusRequest: (cb) => on<string>(IpcEvent.SessionFocusRequest, cb),
  },
  models: {
    listCustom: () =>
      ipcRenderer.invoke(IpcInvoke.ModelsListCustom) as Promise<CustomModelEntry[]>,
    saveCustom: (model: CustomModelInput, originalDisplayName?: string) =>
      ipcRenderer.invoke(
        IpcInvoke.ModelsSaveCustom,
        model,
        originalDisplayName,
      ) as Promise<SaveCustomModelResult>,
    deleteCustom: (displayName) =>
      ipcRenderer.invoke(IpcInvoke.ModelsDeleteCustom, displayName) as Promise<void>,
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcInvoke.SettingsGet) as Promise<DesktopUserSettings>,
    update: (patch: DesktopUserSettings) =>
      ipcRenderer.invoke(IpcInvoke.SettingsUpdate, patch) as Promise<DesktopUserSettings>,
    getInstructions: () => ipcRenderer.invoke(IpcInvoke.InstructionsGet) as Promise<string>,
    saveInstructions: (content: string) =>
      ipcRenderer.invoke(IpcInvoke.InstructionsSave, content) as Promise<string>,
  },
  theme: {
    set: (mode: ThemeMode) => ipcRenderer.invoke(IpcInvoke.ThemeSet, mode) as Promise<void>,
  },
  computerUse: {
    status: () =>
      ipcRenderer.invoke(IpcInvoke.ComputerUseStatus) as Promise<ComputerUseStatus>,
    setEnabled: (enabled) =>
      ipcRenderer.invoke(IpcInvoke.ComputerUseSetEnabled, enabled) as Promise<ComputerUseStatus>,
    stop: () => ipcRenderer.invoke(IpcInvoke.ComputerUseStop) as Promise<void>,
    onStatus: (cb) => on<ComputerUseStatus>(IpcEvent.ComputerUseStatus, cb),
    onStopRequested: (cb) => on<void>(IpcEvent.ComputerUseStopRequested, cb),
  },
  agents: {
    detect: () =>
      ipcRenderer.invoke(IpcInvoke.AgentsDetect) as Promise<ExternalAgentAvailability>,
  },
  ide: {
    detect: () => ipcRenderer.invoke(IpcInvoke.IdeDetect) as Promise<DetectedIde[]>,
    open: (ideId, target) =>
      ipcRenderer.invoke(IpcInvoke.IdeOpen, ideId, target) as Promise<void>,
  },
  feishu: {
    status: () => ipcRenderer.invoke(IpcInvoke.FeishuStatus) as Promise<FeishuStatus>,
    saveManual: (input: FeishuManualInput) =>
      ipcRenderer.invoke(IpcInvoke.FeishuSaveManual, input) as Promise<FeishuResult>,
    qrBegin: (domain: FeishuDomain) =>
      ipcRenderer.invoke(IpcInvoke.FeishuQrBegin, domain) as Promise<FeishuQrBeginResult>,
    qrPoll: (begin: FeishuQrBegin) =>
      ipcRenderer.invoke(IpcInvoke.FeishuQrPoll, begin) as Promise<FeishuResult>,
    qrCancel: () => ipcRenderer.invoke(IpcInvoke.FeishuQrCancel) as Promise<void>,
    clear: () => ipcRenderer.invoke(IpcInvoke.FeishuClear) as Promise<FeishuStatus>,
    start: () => ipcRenderer.invoke(IpcInvoke.FeishuStart) as Promise<FeishuResult>,
    stop: () => ipcRenderer.invoke(IpcInvoke.FeishuStop) as Promise<FeishuStatus>,
    detectExternal: () =>
      ipcRenderer.invoke(IpcInvoke.FeishuDetectExternal) as Promise<FeishuExternalProcess[]>,
    killExternal: () => ipcRenderer.invoke(IpcInvoke.FeishuKillExternal) as Promise<number>,
    lobby: () => ipcRenderer.invoke(IpcInvoke.FeishuLobby) as Promise<FeishuLobby>,
    onChanged: (cb) => on<FeishuStatus>(IpcEvent.FeishuChanged, cb),
  },
  permissions: {
    onRequest: (cb) => on<PermissionRequest>(IpcEvent.PermissionRequest, cb),
    respond: (requestId, response: PermissionResponse) =>
      ipcRenderer.invoke(IpcInvoke.PermissionRespond, requestId, response) as Promise<void>,
  },
  workspace: {
    pickFolder: () => ipcRenderer.invoke(IpcInvoke.PickFolder) as Promise<string | undefined>,
    pickFiles: () => ipcRenderer.invoke(IpcInvoke.PickFiles) as Promise<PickedFile[]>,
    readFile: (p) => ipcRenderer.invoke(IpcInvoke.ReadFile, p) as Promise<string>,
    readFileBase64: (p) =>
      ipcRenderer.invoke(IpcInvoke.ReadFileBase64, p) as Promise<FileBase64 | null>,
    listDir: (p) => ipcRenderer.invoke(IpcInvoke.ListDir, p) as Promise<DirEntry[]>,
    searchFiles: (root) => ipcRenderer.invoke(IpcInvoke.SearchFiles, root) as Promise<string[]>,
    revealInFolder: (p) => ipcRenderer.invoke(IpcInvoke.RevealInFolder, p) as Promise<void>,
    openInTerminal: (dir) => ipcRenderer.invoke(IpcInvoke.OpenInTerminal, dir) as Promise<void>,
    gitDiff: (cwd, sessionId) =>
      ipcRenderer.invoke(IpcInvoke.GitDiff, cwd, sessionId) as Promise<GitFileDiff[]>,
    gitBranch: (cwd) =>
      ipcRenderer.invoke(IpcInvoke.GitBranch, cwd) as Promise<{ branch: string; dirty: boolean } | null>,
    openExternal: (url) => ipcRenderer.invoke(IpcInvoke.OpenExternal, url) as Promise<void>,
    saveClipboardImage: (cwd, mimeType, data, name) =>
      ipcRenderer.invoke(
        IpcInvoke.SaveClipboardImage,
        cwd,
        mimeType,
        data,
        name,
      ) as Promise<string | null>,
  },
  clipboard: {
    readImage: () => ipcRenderer.invoke(IpcInvoke.ReadClipboardImage) as Promise<FileBase64 | null>,
    writeText: (text) => ipcRenderer.invoke(IpcInvoke.WriteClipboardText, text) as Promise<void>,
  },
  backend: {
    onLog: (cb) => on<string>(IpcEvent.BackendLog, cb),
  },
  terminal: {
    listShells: () => ipcRenderer.invoke(IpcInvoke.TerminalListShells) as Promise<ShellOption[]>,
    create: (cwd, cols, rows) =>
      ipcRenderer.invoke(IpcInvoke.TerminalCreate, cwd, cols, rows) as Promise<TerminalHandle>,
    input: (id, data) => ipcRenderer.invoke(IpcInvoke.TerminalInput, id, data) as Promise<void>,
    resize: (id, cols, rows) =>
      ipcRenderer.invoke(IpcInvoke.TerminalResize, id, cols, rows) as Promise<void>,
    close: (id) => ipcRenderer.invoke(IpcInvoke.TerminalClose, id) as Promise<void>,
    onData: (cb) => on<TerminalDataEvent>(IpcEvent.TerminalData, cb),
    onExit: (cb) => on<TerminalExitEvent>(IpcEvent.TerminalExit, cb),
  },
  updater: {
    getState: () => ipcRenderer.invoke(IpcInvoke.UpdateGetState) as Promise<UpdateState>,
    check: (manual) =>
      ipcRenderer.invoke(IpcInvoke.UpdateCheck, manual) as Promise<UpdateCheckResult>,
    download: () => ipcRenderer.invoke(IpcInvoke.UpdateDownload) as Promise<UpdateState>,
    cancelDownload: () => ipcRenderer.invoke(IpcInvoke.UpdateCancelDownload) as Promise<void>,
    install: () => ipcRenderer.invoke(IpcInvoke.UpdateInstall) as Promise<void>,
    skip: (version) => ipcRenderer.invoke(IpcInvoke.UpdateSkip, version) as Promise<void>,
    snooze: () => ipcRenderer.invoke(IpcInvoke.UpdateSnooze) as Promise<void>,
    onStatus: (cb) => on<UpdateState>(IpcEvent.UpdateStatus, cb),
    onProgress: (cb) => on<UpdateDownloadProgress>(IpcEvent.UpdateProgress, cb),
  },
};

contextBridge.exposeInMainWorld('easycode', bridge);

// Tag the document root with the OS so the renderer's CSS can adapt platform
// chrome — e.g. reserve space for macOS' traffic-light window controls under
// `hiddenInset` so they don't overlap the sidebar logo. (`tsconfig.node.json`
// has no DOM lib, so describe the tiny surface we touch with a local type.)
{
  type MinimalDoc = {
    readyState: string;
    documentElement: { setAttribute(name: string, value: string): void };
    addEventListener(type: string, cb: () => void, opts?: { once?: boolean }): void;
  };
  const doc = (globalThis as { document?: MinimalDoc }).document;
  if (doc) {
    const setPlatform = () =>
      doc.documentElement.setAttribute('data-platform', process.platform);
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', setPlatform, { once: true });
    } else {
      setPlatform();
    }
  }
}
