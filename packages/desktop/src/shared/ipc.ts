/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * The single source of truth for the main <-> renderer contract.
 *
 * The renderer never touches Node, ACP, or `deepv-code-core` directly. It only
 * speaks this typed protocol through the `window.easycode` bridge installed by
 * the preload script. Main implements the handlers; the bridge in preload mirrors
 * this surface 1:1.
 */

// ──────────────────────────────────────────────────────────────────────────
// Channel names
// ──────────────────────────────────────────────────────────────────────────

/** Renderer -> main, request/response (ipcRenderer.invoke / ipcMain.handle). */
export const IpcInvoke = {
  // auth
  AuthStatus: 'auth:status',
  AuthLoginApiKey: 'auth:login-apikey',
  AuthLoginBrowser: 'auth:login-browser',
  AuthCancelBrowser: 'auth:login-browser-cancel',
  AuthLogout: 'auth:logout',
  // sessions
  SessionList: 'session:list',
  SessionCreate: 'session:create',
  SessionResume: 'session:resume',
  SessionClose: 'session:close',
  SessionPrompt: 'session:prompt',
  SessionCancel: 'session:cancel',
  SessionSetModel: 'session:set-model',
  SessionSetMode: 'session:set-mode',
  SessionRewind: 'session:rewind',
  SessionArchive: 'session:archive',
  // external agents
  AgentsDetect: 'agents:detect',
  // custom models
  ModelsListCustom: 'models:list-custom',
  ModelsSaveCustom: 'models:save-custom',
  ModelsDeleteCustom: 'models:delete-custom',
  // permission reply
  PermissionRespond: 'permission:respond',
  // workspace helpers
  PickFolder: 'workspace:pick-folder',
  ReadFile: 'workspace:read-file',
  ListDir: 'workspace:list-dir',
  GitDiff: 'workspace:git-diff',
  OpenExternal: 'workspace:open-external',
} as const;

/** Main -> renderer, push events (webContents.send / ipcRenderer.on). */
export const IpcEvent = {
  AuthChanged: 'auth:changed',
  SessionEvent: 'session:event',
  SessionStatus: 'session:status',
  PermissionRequest: 'permission:request',
  BackendLog: 'backend:log',
} as const;

// ──────────────────────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────────────────────

export interface DesktopUser {
  userId: string;
  name?: string;
  email?: string;
  avatar?: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  user?: DesktopUser;
  /** Resolved proxy server base URL the desktop and backend talk to. */
  serverUrl: string;
}

export interface ApiKeyLoginResult {
  ok: boolean;
  error?: string;
  status?: AuthStatus;
}

/** Result of kicking off the browser/OAuth flow. */
export interface BrowserLoginResult {
  ok: boolean;
  error?: string;
  /** URL opened in the system browser (also usable inside an in-app window). */
  url?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Sessions
// ──────────────────────────────────────────────────────────────────────────

/**
 * The two permission modes, mapped 1:1 onto the backend's real ApprovalMode
 * values (`default` / `yolo`). The backend has no distinct plan/acceptEdits
 * behaviour, so we don't surface modes it can't honour.
 */
export type PermissionMode =
  | 'default' // ask before each edit/command
  | 'yolo'; // auto-accept everything

export const PERMISSION_MODES: {
  id: PermissionMode;
  label: string;
  hint: string;
}[] = [
  { id: 'default', label: '每次询问', hint: '每次编辑/命令前询问' },
  { id: 'yolo', label: 'YOLO 自动接受', hint: '自动接受所有编辑与命令，不再询问' },
];

export type SessionRunStatus =
  | 'idle' // ready, waiting for input
  | 'starting' // backend process spawning / authenticating
  | 'thinking' // model is producing output
  | 'needs_approval' // a permission request is pending
  | 'error'
  | 'exited'; // backend process gone

export type EnvironmentKind = 'local'; // remote/ssh reserved for the future

/**
 * Which agent backend drives a session.
 *   - `easy-code`   — the bundled `easycode --acp` backend (default).
 *   - `claude-code` — the user's local Claude Code, via the
 *                     `@agentclientprotocol/claude-agent-acp` ACP bridge.
 *   - `codex`       — the user's local Codex CLI, via `@zed-industries/codex-acp`.
 * The external agents speak the same ACP protocol, so the desktop drives them
 * with the identical client — only the spawned command differs.
 */
export type AgentKind = 'easy-code' | 'claude-code' | 'codex';

/** Which local external agents were detected on PATH (claude / codex). */
export interface ExternalAgentAvailability {
  /** True when `claude` resolves on PATH. */
  claudeCode: boolean;
  /** True when `codex` resolves on PATH. */
  codex: boolean;
}

export interface ModelInfo {
  modelId: string;
  name: string;
}

export interface SessionMeta {
  /** Stable desktop-side id (also the ACP sessionId once created). */
  id: string;
  title: string;
  cwd: string;
  environment: EnvironmentKind;
  status: SessionRunStatus;
  /** Which agent backend drives this session. */
  agentType: AgentKind;
  permissionMode: PermissionMode;
  model?: string;
  availableModels: ModelInfo[];
  /** Cumulative token usage from the latest usage_update. */
  tokenUsed?: number;
  tokenSize?: number;
  /** Aggregate diff stat across the session, for the +N -M chip. */
  added: number;
  removed: number;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Custom models (stored in ~/.easycode-user/custom-models.json, shared w/ CLI)
// ──────────────────────────────────────────────────────────────────────────

export type CustomModelProvider =
  | 'openai'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini';

/** The user-editable fields of a custom model. */
export interface CustomModelInput {
  /** Display name; also the unique key in the store. */
  displayName: string;
  provider: CustomModelProvider;
  /** API base URL. */
  baseUrl: string;
  /** API key (supports ${ENV_VAR} substitution, resolved by the backend). */
  apiKey: string;
  /** Actual model id sent to the provider. */
  modelId: string;
  /** Optional context-window size. */
  maxTokens?: number;
  enabled?: boolean;
}

/** A stored custom model enriched with its generated id + display label. */
export interface CustomModelEntry extends CustomModelInput {
  /** Generated `custom:...` id — the value passed to `sessions.setModel`. */
  id: string;
  /** "[Provider] displayName" — what the picker shows. */
  label: string;
}

export interface SaveCustomModelResult {
  ok: boolean;
  error?: string;
}

export interface CreateSessionOptions {
  cwd: string;
  title?: string;
  /** Agent backend to drive the session. Defaults to `easy-code`. */
  agentType?: AgentKind;
  permissionMode?: PermissionMode;
  model?: string;
}

export interface PromptOptions {
  sessionId: string;
  /** Plain text (may contain @file references). */
  text: string;
  /** Absolute paths attached via @-references, resolved by the renderer. */
  atPaths?: string[];
  /** base64 image attachments. */
  images?: { mimeType: string; data: string }[];
}

// ──────────────────────────────────────────────────────────────────────────
// Session events (ACP sessionUpdate, normalized for the renderer)
// ──────────────────────────────────────────────────────────────────────────

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type ToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

export interface ToolLocation {
  path: string;
  line?: number;
}

/** A diff carried inside a tool call (write/edit preview). */
export interface ToolDiff {
  path: string;
  oldText?: string | null;
  newText: string;
}

/** Normalized content attached to a tool call / update. */
export interface ToolCallContent {
  text?: string;
  diff?: ToolDiff;
}

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SlashCommand {
  name: string;
  description: string;
}

/**
 * The normalized event union pushed to the renderer for a given session.
 * Mirrors the ACP `sessionUpdate` notifications plus desktop lifecycle events.
 */
export type DesktopSessionEvent =
  | { kind: 'turn_start' }
  | { kind: 'turn_end'; stopReason?: string }
  | { kind: 'message_chunk'; text: string }
  | { kind: 'thought_chunk'; text: string }
  | { kind: 'user_chunk'; text: string }
  | { kind: 'mode_marker'; mode: string } // [MODE_UPDATE]/[Model switched...] markers
  | {
      kind: 'tool_call';
      toolCallId: string;
      title: string;
      toolKind: AcpToolKind;
      status: ToolCallStatus;
      locations?: ToolLocation[];
      content?: ToolCallContent[];
    }
  | {
      kind: 'tool_update';
      toolCallId: string;
      status?: ToolCallStatus;
      title?: string;
      content?: ToolCallContent[];
      terminalOutput?: string;
    }
  | { kind: 'plan'; entries: PlanEntry[] }
  | { kind: 'usage'; used: number; size: number }
  | { kind: 'commands'; commands: SlashCommand[] }
  | { kind: 'error'; message: string };

export interface SessionEventEnvelope {
  sessionId: string;
  event: DesktopSessionEvent;
}

export interface SessionStatusEnvelope {
  sessionId: string;
  status: SessionRunStatus;
  meta?: Partial<SessionMeta>;
}

// ──────────────────────────────────────────────────────────────────────────
// Permission requests
// ──────────────────────────────────────────────────────────────────────────

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  toolKind: AcpToolKind;
  options: PermissionOption[];
  /** Optional diff/content preview to render in the approval dialog. */
  content?: ToolCallContent[];
}

export type PermissionResponse =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

// ──────────────────────────────────────────────────────────────────────────
// Workspace helpers
// ──────────────────────────────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface GitFileDiff {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  added: number;
  removed: number;
  /** Unified diff hunks as raw text. */
  patch: string;
}

export interface RewindResult {
  keptUserMessageCount: number;
  droppedContentCount: number;
}

// ──────────────────────────────────────────────────────────────────────────
// The bridge surface exposed on window.easycode (preload).
// ──────────────────────────────────────────────────────────────────────────

export interface EasycodeBridge {
  auth: {
    status(): Promise<AuthStatus>;
    loginApiKey(apiKey: string): Promise<ApiKeyLoginResult>;
    loginBrowser(): Promise<BrowserLoginResult>;
    cancelBrowserLogin(): Promise<void>;
    logout(): Promise<void>;
    onChanged(cb: (status: AuthStatus) => void): () => void;
  };
  sessions: {
    list(): Promise<SessionMeta[]>;
    create(opts: CreateSessionOptions): Promise<SessionMeta>;
    resume(sessionId: string, cwd: string): Promise<SessionMeta>;
    close(sessionId: string): Promise<void>;
    archive(sessionId: string, archived: boolean): Promise<void>;
    prompt(opts: PromptOptions): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    setModel(sessionId: string, modelId: string): Promise<void>;
    setMode(sessionId: string, mode: PermissionMode): Promise<void>;
    rewind(sessionId: string, beforeUserMessageIndex: number): Promise<RewindResult>;
    onEvent(cb: (env: SessionEventEnvelope) => void): () => void;
    onStatus(cb: (env: SessionStatusEnvelope) => void): () => void;
  };
  models: {
    /** List the user's custom models (shared with the CLI). */
    listCustom(): Promise<CustomModelEntry[]>;
    /**
     * Add or update a custom model. Pass `originalDisplayName` when an edit
     * renamed the model so the old entry is replaced, not orphaned.
     */
    saveCustom(
      model: CustomModelInput,
      originalDisplayName?: string,
    ): Promise<SaveCustomModelResult>;
    deleteCustom(displayName: string): Promise<void>;
  };
  agents: {
    /** Detect which external agents (Claude Code / Codex) are installed locally. */
    detect(): Promise<ExternalAgentAvailability>;
  };
  permissions: {
    onRequest(cb: (req: PermissionRequest) => void): () => void;
    respond(requestId: string, response: PermissionResponse): Promise<void>;
  };
  workspace: {
    pickFolder(): Promise<string | undefined>;
    readFile(path: string): Promise<string>;
    listDir(path: string): Promise<DirEntry[]>;
    /** Pass `sessionId` to also refresh that session's +N/-M chip in the sidebar. */
    gitDiff(cwd: string, sessionId?: string): Promise<GitFileDiff[]>;
    openExternal(url: string): Promise<void>;
  };
  backend: {
    onLog(cb: (line: string) => void): () => void;
  };
}

declare global {
  interface Window {
    easycode: EasycodeBridge;
  }
}
