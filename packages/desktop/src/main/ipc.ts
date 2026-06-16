/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Wires the typed {@link IpcInvoke}/{@link IpcEvent} contract to concrete
 * handlers (auth, sessions, permissions, workspace) and forwards push events to
 * the renderer.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { SessionHub } from './sessionHub.js';
import { FeishuManager } from './feishu.js';
import { TurnNotifier } from './notifications.js';
import {
  cancelBrowserLogin,
  getAuthStatus,
  loginWithApiKey,
  logout,
  onAuthChanged,
  startBrowserLogin,
} from './auth.js';
import {
  gitDiff,
  gitBranch,
  listDir,
  openExternal,
  pickFiles,
  pickFolder,
  readClipboardImage,
  readFile,
  readFileBase64,
  saveClipboardImage,
} from './workspace.js';
import { deleteCustomModel, listCustomModels, saveCustomModel } from './customModels.js';
import { getUserSettings, updateUserSettings } from './userSettings.js';
import { detectExternalAgents } from './externalAgents.js';
import { IpcEvent, IpcInvoke } from '../shared/ipc.js';
import type {
  ApiKeyLoginResult,
  BrowserLoginResult,
  CreateSessionOptions,
  CustomModelInput,
  DesktopUserSettings,
  FeishuDomain,
  FeishuManualInput,
  FeishuQrBegin,
  PermissionMode,
  PermissionResponse,
  PromptOptions,
} from '../shared/ipc.js';

/** What {@link registerIpc} hands back to the app entry for lifecycle teardown. */
export interface IpcServices {
  hub: SessionHub;
  feishu: FeishuManager;
}

export function registerIpc(getWindow: () => BrowserWindow | null): IpcServices {
  const send = (channel: string, payload: unknown) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const hub = new SessionHub({
    sessionEvent: (sessionId, event) => {
      // Maybe raise a turn-complete system notification (no-op while focused),
      // then forward the event to the renderer as usual.
      notifier.handle(sessionId, event);
      send(IpcEvent.SessionEvent, { sessionId, event });
    },
    sessionStatus: (sessionId, status, meta) =>
      send(IpcEvent.SessionStatus, { sessionId, status, meta }),
    permissionRequest: (req) => send(IpcEvent.PermissionRequest, req),
    backendLog: (line) => send(IpcEvent.BackendLog, line),
  });

  // Surfaces a system notification when a turn finishes while the window is in
  // the background; clicking it restores the window and selects the session.
  const notifier = new TurnNotifier({
    getWindow,
    getTitle: (id) => hub.list().find((s) => s.id === id)?.title,
    focusSession: (id) => send(IpcEvent.SessionFocusRequest, id),
  });

  const pushAuth = () => send(IpcEvent.AuthChanged, getAuthStatus());
  onAuthChanged(pushAuth);

  // ── auth ──────────────────────────────────────────────────────────────
  ipcMain.handle(IpcInvoke.AuthStatus, () => getAuthStatus());
  ipcMain.handle(IpcInvoke.AuthLoginApiKey, async (_e, apiKey: string): Promise<ApiKeyLoginResult> => {
    const res = await loginWithApiKey(apiKey);
    if (res.ok) pushAuth();
    return { ...res, status: res.ok ? getAuthStatus() : undefined };
  });
  ipcMain.handle(IpcInvoke.AuthLoginBrowser, async (): Promise<BrowserLoginResult> =>
    startBrowserLogin(() => pushAuth()),
  );
  ipcMain.handle(IpcInvoke.AuthCancelBrowser, () => cancelBrowserLogin());
  ipcMain.handle(IpcInvoke.AuthLogout, () => {
    logout();
    pushAuth();
  });

  // ── sessions ────────────────────────────────────────────────────────────
  ipcMain.handle(IpcInvoke.SessionList, () => hub.list());
  ipcMain.handle(IpcInvoke.SessionCreate, (_e, opts: CreateSessionOptions) => hub.create(opts));
  ipcMain.handle(IpcInvoke.SessionCreateChat, (_e, opts?: Omit<CreateSessionOptions, 'cwd'>) =>
    hub.createChat(opts),
  );
  ipcMain.handle(IpcInvoke.SessionResume, (_e, id: string, cwd: string) => hub.resume(id, cwd));
  ipcMain.handle(IpcInvoke.SessionClose, (_e, id: string) => hub.close(id));
  ipcMain.handle(IpcInvoke.SessionArchive, (_e, id: string, archived: boolean) =>
    hub.archive(id, archived),
  );
  ipcMain.handle(IpcInvoke.SessionRename, (_e, id: string, title: string) =>
    hub.rename(id, title),
  );
  ipcMain.handle(IpcInvoke.SessionSetTitleProvisional, (_e, id: string, title: string) =>
    hub.setTitleProvisional(id, title),
  );
  ipcMain.handle(IpcInvoke.SessionPrompt, (_e, opts: PromptOptions) =>
    hub.prompt(opts.sessionId, opts.text, opts.atPaths, opts.images),
  );
  ipcMain.handle(IpcInvoke.SessionCancel, (_e, id: string) => hub.cancel(id));
  ipcMain.handle(IpcInvoke.SessionSetModel, (_e, id: string, modelId: string) =>
    hub.setModel(id, modelId),
  );
  ipcMain.handle(IpcInvoke.SessionSetMode, (_e, id: string, mode: PermissionMode) =>
    hub.setMode(id, mode),
  );
  ipcMain.handle(IpcInvoke.SessionRewind, (_e, id: string, idx: number) => hub.rewind(id, idx));

  // ── external agents ───────────────────────────────────────────────────────
  ipcMain.handle(IpcInvoke.AgentsDetect, () => detectExternalAgents());

  // ── feishu gateway ────────────────────────────────────────────────────────
  const feishu = new FeishuManager(
    (status) => send(IpcEvent.FeishuChanged, status),
    (line) => send(IpcEvent.BackendLog, `[feishu] ${line}`),
  );
  ipcMain.handle(IpcInvoke.FeishuStatus, () => feishu.getStatus());
  ipcMain.handle(IpcInvoke.FeishuSaveManual, (_e, input: FeishuManualInput) =>
    feishu.saveManualCredentials(input),
  );
  ipcMain.handle(IpcInvoke.FeishuQrBegin, (_e, domain: FeishuDomain) => feishu.qrBegin(domain));
  ipcMain.handle(IpcInvoke.FeishuQrPoll, (_e, begin: FeishuQrBegin) => feishu.qrPoll(begin));
  ipcMain.handle(IpcInvoke.FeishuQrCancel, () => feishu.qrCancel());
  ipcMain.handle(IpcInvoke.FeishuClear, () => feishu.clearCredentials());
  ipcMain.handle(IpcInvoke.FeishuStart, () => feishu.start());
  ipcMain.handle(IpcInvoke.FeishuStop, () => feishu.stop());
  ipcMain.handle(IpcInvoke.FeishuDetectExternal, () => feishu.detectExternal());
  ipcMain.handle(IpcInvoke.FeishuKillExternal, () => feishu.killExternal());
  ipcMain.handle(IpcInvoke.FeishuLobby, () => feishu.getLobby());

  // ── custom models ─────────────────────────────────────────────────────────
  ipcMain.handle(IpcInvoke.ModelsListCustom, () => listCustomModels());
  ipcMain.handle(
    IpcInvoke.ModelsSaveCustom,
    (_e, model: CustomModelInput, originalDisplayName?: string) =>
      saveCustomModel(model, originalDisplayName),
  );
  ipcMain.handle(IpcInvoke.ModelsDeleteCustom, (_e, displayName: string) =>
    deleteCustomModel(displayName),
  );

  // ── user settings (shared with CLI's /config) ─────────────────────────────
  ipcMain.handle(IpcInvoke.SettingsGet, () => getUserSettings());
  ipcMain.handle(IpcInvoke.SettingsUpdate, (_e, patch: DesktopUserSettings) =>
    updateUserSettings(patch),
  );

  // ── permissions ─────────────────────────────────────────────────────────
  ipcMain.handle(
    IpcInvoke.PermissionRespond,
    (_e, requestId: string, response: PermissionResponse) =>
      hub.respondPermission(requestId, response),
  );

  // ── workspace ─────────────────────────────────────────────────────────
  ipcMain.handle(IpcInvoke.PickFolder, () => pickFolder(getWindow() ?? undefined));
  ipcMain.handle(IpcInvoke.PickFiles, () => pickFiles(getWindow() ?? undefined));
  ipcMain.handle(IpcInvoke.ReadFile, (_e, p: string) => readFile(p));
  ipcMain.handle(IpcInvoke.ReadFileBase64, (_e, p: string) => readFileBase64(p));
  ipcMain.handle(IpcInvoke.ListDir, (_e, p: string) => listDir(p));
  ipcMain.handle(IpcInvoke.GitDiff, async (_e, cwd: string, sessionId?: string) => {
    const diffs = await gitDiff(cwd);
    if (sessionId) {
      const totals = diffs.reduce(
        (acc, d) => ({ added: acc.added + d.added, removed: acc.removed + d.removed }),
        { added: 0, removed: 0 },
      );
      hub.applyDiffStat(sessionId, totals.added, totals.removed);
    }
    return diffs;
  });
  ipcMain.handle(IpcInvoke.OpenExternal, (_e, url: string) => openExternal(url));
  ipcMain.handle(IpcInvoke.GitBranch, (_e, cwd: string) => gitBranch(cwd));
  ipcMain.handle(
    IpcInvoke.SaveClipboardImage,
    (_e, cwd: string, mimeType: string, data: string, name?: string) =>
      saveClipboardImage(cwd, mimeType, data, name),
  );

  // ── clipboard ─────────────────────────────────────────────────────────
  ipcMain.handle(IpcInvoke.ReadClipboardImage, () => readClipboardImage());

  return { hub, feishu };
}
