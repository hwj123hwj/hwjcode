/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owns all live {@link AcpSessionBridge}s plus persisted session metadata, and
 * routes ACP events / permission round-trips to the renderer. One hub per app.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { AcpSessionBridge } from './acpSession.js';
import type {
  AgentKind,
  CreateSessionOptions,
  DesktopSessionEvent,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  RewindResult,
  SessionMeta,
  SessionRunStatus,
  ThinkingMode,
} from '../shared/ipc.js';

interface PersistedSession extends SessionMeta {
  /** Backend (core) session id, used to resume via ACP session/load. */
  acpSessionId?: string;
  /**
   * True once the user has manually renamed the session. Suppresses the
   * backend's auto-generated `[TITLE_UPDATE]` so a hand-picked title is never
   * overwritten.
   */
  titleLocked?: boolean;
}

export interface HubEmitters {
  sessionEvent(sessionId: string, event: DesktopSessionEvent): void;
  sessionStatus(sessionId: string, status: SessionRunStatus, meta?: Partial<SessionMeta>): void;
  permissionRequest(req: PermissionRequest): void;
  backendLog(line: string): void;
}

export class SessionHub {
  private readonly bridges = new Map<string, AcpSessionBridge>();
  private readonly records = new Map<string, PersistedSession>();
  private readonly acpIds = new Map<string, string>(); // handle -> acp session id
  private readonly pendingPermissions = new Map<
    string,
    (response: PermissionResponse) => void
  >();
  private readonly storePath: string;

  constructor(private readonly emit: HubEmitters) {
    this.storePath = path.join(app.getPath('userData'), 'sessions.json');
    this.load();
  }

  // ── persistence ─────────────────────────────────────────────────────────

  private load(): void {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const arr = JSON.parse(raw) as PersistedSession[];
      for (const rec of arr) {
        // Restored sessions are dormant until explicitly resumed.
        rec.status = 'idle';
        // Backfill agentType for sessions persisted before this field existed.
        if (!rec.agentType) rec.agentType = 'easy-code';
        // Backfill kind for sessions persisted before sidebar grouping existed:
        // a cwd under the chats root is a chat, everything else a project.
        if (!rec.kind) rec.kind = isChatCwd(rec.cwd) ? 'chat' : 'project';
        // Backfill availableModels: the renderer maps over it on render, so an
        // older record without it would crash the session view (white screen)
        // until the resume round-trip repopulated it.
        if (!Array.isArray(rec.availableModels)) rec.availableModels = [];
        this.records.set(rec.id, rec);
        if (rec.acpSessionId) this.acpIds.set(rec.id, rec.acpSessionId);
      }
    } catch {
      /* no store yet */
    }
  }

  private persist(): void {
    try {
      const arr = [...this.records.values()];
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(arr, null, 2), 'utf8');
    } catch {
      /* best effort */
    }
  }

  private touch(id: string, patch: Partial<PersistedSession>): SessionMeta | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    Object.assign(rec, patch, { updatedAt: Date.now() });
    this.persist();
    return rec;
  }

  // ── queries ─────────────────────────────────────────────────────────────

  list(): SessionMeta[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  private makeBridge(id: string, cwd: string, agentType: AgentKind): AcpSessionBridge {
    const bridge = new AcpSessionBridge(
      id,
      cwd,
      {
        emit: (event) => {
          // The auto-generated title is metadata, not a transcript bubble:
          // fold it into the session record (unless the user renamed it) and
          // push it to the renderer as a meta patch via sessionStatus.
          if (event.kind === 'title') {
            const rec = this.records.get(id);
            if (rec && !rec.titleLocked && event.title) {
              const updated = this.touch(id, { title: event.title });
              if (updated) {
                this.emit.sessionStatus(id, updated.status, { title: updated.title });
              }
            }
            return;
          }
          this.emit.sessionEvent(id, event);
        },
        setStatus: (status) => {
          this.touch(id, { status });
          this.emit.sessionStatus(id, status);
        },
        requestPermission: (req) => this.askPermission(id, req),
        log: (line) => this.emit.backendLog(`[${id.slice(0, 8)}] ${line}`),
      },
      agentType,
    );
    this.bridges.set(id, bridge);
    return bridge;
  }

  async create(opts: CreateSessionOptions): Promise<SessionMeta> {
    const id = randomUUID();
    const now = Date.now();
    const agentType: AgentKind = opts.agentType ?? 'easy-code';
    const rec: PersistedSession = {
      id,
      title: opts.title || defaultTitle(opts.cwd),
      cwd: opts.cwd,
      environment: 'local',
      status: 'starting',
      agentType,
      kind: opts.kind ?? 'project',
      permissionMode: opts.permissionMode ?? 'default',
      model: opts.model,
      availableModels: [],
      added: 0,
      removed: 0,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    this.records.set(id, rec);
    this.persist();

    const bridge = this.makeBridge(id, opts.cwd, agentType);
    const res = await bridge.start();
    this.acpIds.set(id, res.acpSessionId);
    const updated = this.touch(id, {
      acpSessionId: res.acpSessionId,
      availableModels: res.availableModels,
      model: opts.model ?? res.model,
      permissionMode: opts.permissionMode ?? res.mode,
      thinking: res.thinking,
      status: 'idle',
    })!;

    // Permission modes are an Easy Code concept; external agents manage their
    // own approval flow (and surface it via ACP requestPermission, which the
    // desktop already presents). Only reconcile mode/model for Easy Code.
    if (agentType === 'easy-code') {
      if (opts.permissionMode && opts.permissionMode !== res.mode) {
        await bridge.setMode(opts.permissionMode).catch(() => undefined);
      }
    }
    if (opts.model && opts.model !== res.model) {
      await bridge.setModel(opts.model).catch(() => undefined);
    }
    return updated;
  }

  /**
   * Start a directory-less "just chat" session. We mint a throwaway working
   * directory under `~/.easycode-user/chats/<id>` so the agent has a real,
   * isolated cwd to operate in without touching the user's home or projects.
   */
  async createChat(
    opts: Omit<CreateSessionOptions, 'cwd'> = {},
  ): Promise<SessionMeta> {
    const id = randomUUID();
    const cwd = path.join(chatsRoot(), id);
    fs.mkdirSync(cwd, { recursive: true });
    return this.create({ ...opts, cwd, kind: 'chat' });
  }

  /**
   * Set a provisional title (e.g. first user message) WITHOUT locking it, so a
   * later backend `[TITLE_UPDATE]` can still refine it. No-ops once the user has
   * manually renamed (titleLocked).
   */
  setTitleProvisional(id: string, title: string): SessionMeta | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    if (rec.titleLocked) return rec; // respect manual rename
    const next = title.trim();
    if (!next) return rec;
    const updated = this.touch(id, { title: next });
    if (updated) this.emit.sessionStatus(id, updated.status, { title: updated.title });
    return updated;
  }

  async resume(id: string, cwd: string): Promise<SessionMeta> {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`Unknown session: ${id}`);
    if (this.bridges.has(id)) return rec; // already live

    const bridge = this.makeBridge(id, cwd || rec.cwd, rec.agentType ?? 'easy-code');
    const res = await bridge.start(this.acpIds.get(id) ?? rec.acpSessionId);
    this.acpIds.set(id, res.acpSessionId);
    return this.touch(id, {
      acpSessionId: res.acpSessionId,
      availableModels: res.availableModels,
      model: rec.model ?? res.model,
      thinking: res.thinking ?? rec.thinking,
      status: 'idle',
      archived: false,
    })!;
  }

  async close(id: string): Promise<void> {
    const bridge = this.bridges.get(id);
    if (bridge) {
      bridge.dispose();
      this.bridges.delete(id);
    }
    this.touch(id, { status: 'idle' });
  }

  async archive(id: string, archived: boolean): Promise<void> {
    await this.close(id).catch(() => undefined);
    this.touch(id, { archived });
  }

  /**
   * Permanently remove a session. Disposes any live bridge, drops the in-memory
   * record + acp id mapping, and rewrites `sessions.json` without it. For a
   * directory-less "just chat" session we also delete its throwaway working
   * directory (`~/.easycode-user/chats/<id>`) — but ONLY when the cwd still
   * matches that exact, app-owned path, so a project session can never take its
   * real source tree down with it. No-ops if the id is unknown.
   */
  async delete(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) return;
    await this.close(id).catch(() => undefined);
    this.records.delete(id);
    this.acpIds.delete(id);
    this.persist();

    // Only a chat session owns a disposable cwd we minted. Guard hard: the path
    // must be exactly `<chatsRoot>/<sessionId>` before we recursively remove it.
    if (rec.kind === 'chat') {
      const expected = path.resolve(path.join(chatsRoot(), id));
      const actual = path.resolve(rec.cwd);
      if (actual === expected && isChatCwd(actual)) {
        try {
          fs.rmSync(actual, { recursive: true, force: true });
        } catch {
          /* best effort — the record is already gone */
        }
      }
    }
  }

  /** Rename a session's display title. Empty/blank falls back to the cwd name. */
  rename(id: string, title: string): SessionMeta {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`Unknown session: ${id}`);
    const next = title.trim() || defaultTitle(rec.cwd);
    // A manual rename pins the title against the backend's auto-titling.
    return this.touch(id, { title: next, titleLocked: true })!;
  }

  // ── prompting ─────────────────────────────────────────────────────────────

  private liveBridge(id: string): AcpSessionBridge {
    const bridge = this.bridges.get(id);
    if (!bridge) throw new Error(`Session ${id} is not running; resume it first.`);
    return bridge;
  }

  async prompt(
    id: string,
    text: string,
    atPaths?: string[],
    images?: { mimeType: string; data: string }[],
  ): Promise<void> {
    await this.liveBridge(id).prompt(text, atPaths ?? [], images ?? []);
  }

  async cancel(id: string): Promise<void> {
    await this.bridges.get(id)?.cancel();
  }

  async setModel(id: string, modelId: string): Promise<void> {
    await this.liveBridge(id).setModel(modelId);
    this.touch(id, { model: modelId });
  }

  async setMode(id: string, mode: PermissionMode): Promise<void> {
    await this.liveBridge(id).setMode(mode);
    this.touch(id, { permissionMode: mode });
  }

  async setThinking(id: string, thinking: ThinkingMode): Promise<void> {
    await this.liveBridge(id).setThinking(thinking);
    this.touch(id, { thinking });
  }

  async rewind(id: string, beforeUserMessageIndex: number): Promise<RewindResult> {
    return this.liveBridge(id).rewind(beforeUserMessageIndex);
  }

  applyDiffStat(id: string, added: number, removed: number): void {
    const updated = this.touch(id, { added, removed });
    if (updated) this.emit.sessionStatus(id, updated.status, { added, removed });
  }

  // ── permission round-trip ──────────────────────────────────────────────

  private askPermission(
    sessionId: string,
    req: Omit<PermissionRequest, 'requestId' | 'sessionId'>,
  ): Promise<PermissionResponse> {
    const requestId = randomUUID();
    return new Promise<PermissionResponse>((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
      this.emit.permissionRequest({ ...req, requestId, sessionId });
    });
  }

  respondPermission(requestId: string, response: PermissionResponse): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (resolve) {
      this.pendingPermissions.delete(requestId);
      resolve(response);
    }
  }

  disposeAll(): void {
    for (const bridge of this.bridges.values()) bridge.dispose();
    this.bridges.clear();
    // Resolve any dangling permission prompts so the backend turns unwind.
    for (const resolve of this.pendingPermissions.values()) {
      resolve({ outcome: 'cancelled' });
    }
    this.pendingPermissions.clear();
  }
}

function defaultTitle(cwd: string): string {
  const base = path.basename(cwd) || cwd;
  return base;
}

/**
 * Root folder for directory-less "just chat" sessions. Lives in the GLOBAL
 * user config dir (`~/.easycode-user/chats`), NOT the project-level `.easycode`
 * and NOT Electron's userData — matching where the CLI keeps shared user state.
 */
function chatsRoot(): string {
  return path.join(os.homedir(), '.easycode-user', 'chats');
}

/** True if a cwd points inside the chats root (used to backfill `kind`). */
function isChatCwd(cwd: string): boolean {
  const root = chatsRoot();
  const norm = path.resolve(cwd);
  return norm === root || norm.startsWith(root + path.sep);
}
