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
  CreateSessionOptions,
  CustomModelEntry,
  CustomModelInput,
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
    resume: (id, cwd) => ipcRenderer.invoke(IpcInvoke.SessionResume, id, cwd) as Promise<SessionMeta>,
    close: (id) => ipcRenderer.invoke(IpcInvoke.SessionClose, id) as Promise<void>,
    archive: (id, archived) =>
      ipcRenderer.invoke(IpcInvoke.SessionArchive, id, archived) as Promise<void>,
    rename: (id, title) =>
      ipcRenderer.invoke(IpcInvoke.SessionRename, id, title) as Promise<SessionMeta>,
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
  agents: {
    detect: () =>
      ipcRenderer.invoke(IpcInvoke.AgentsDetect) as Promise<ExternalAgentAvailability>,
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
    gitDiff: (cwd, sessionId) =>
      ipcRenderer.invoke(IpcInvoke.GitDiff, cwd, sessionId) as Promise<GitFileDiff[]>,
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
  },
  backend: {
    onLog: (cb) => on<string>(IpcEvent.BackendLog, cb),
  },
};

contextBridge.exposeInMainWorld('easycode', bridge);
