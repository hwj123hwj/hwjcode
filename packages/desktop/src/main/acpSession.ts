/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * One live desktop session = one spawned `easycode --acp` backend the desktop
 * drives as an ACP *client*. This mirrors `packages/core/src/acp-client/
 * acpAgentClient.ts` (the delegation client) but, instead of auto-approving and
 * accumulating a transcript string, it:
 *   - forwards every `sessionUpdate` to the renderer as a normalized
 *     {@link DesktopSessionEvent}, and
 *   - turns `requestPermission` into an interactive round-trip to the UI.
 */

import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBackendSpec } from './backendLocator.js';
import { buildExternalAgentSpec } from './externalAgents.js';
import type {
  AgentKind,
  DesktopSessionEvent,
  ModelInfo,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  SessionRunStatus,
  ToolCallContent,
  AcpToolKind,
} from '../shared/ipc.js';

export interface BridgeCallbacks {
  emit(event: DesktopSessionEvent): void;
  setStatus(status: SessionRunStatus): void;
  /** Ask the UI to approve a tool call; resolves with the user's choice. */
  requestPermission(req: Omit<PermissionRequest, 'requestId' | 'sessionId'>): Promise<PermissionResponse>;
  log(line: string): void;
}

/** UI mode -> DeepCode core ApprovalMode id (default/yolo). */
function toApprovalModeId(mode: PermissionMode): string {
  return mode === 'yolo' ? 'yolo' : 'default';
}

/** DeepCode core ApprovalMode id -> UI mode. autoEdit folds into default. */
export function fromApprovalModeId(id: string | undefined): PermissionMode {
  return id === 'yolo' ? 'yolo' : 'default';
}

function textOfContent(content: unknown): string {
  if (content && typeof content === 'object' && 'type' in content) {
    const c = content as { type?: string; text?: string };
    if (c.type === 'text' && typeof c.text === 'string') return c.text;
  }
  return '';
}

/** Map ACP ToolCallContent[] to the normalized renderer shape. */
function normalizeToolContent(items: unknown): ToolCallContent[] | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const out: ToolCallContent[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    if (item.type === 'content') {
      const t = textOfContent(item.content);
      if (t) out.push({ text: t });
    } else if (item.type === 'diff') {
      out.push({
        diff: {
          path: String(item.path ?? ''),
          oldText: (item.oldText as string | null | undefined) ?? null,
          newText: String(item.newText ?? ''),
        },
      });
    }
    // 'terminal' blocks carry only an id; real output arrives via _meta.
  }
  return out.length ? out : undefined;
}

/** Extract real terminal output from a tool_call_update `_meta` channel. */
function terminalFromMeta(meta: unknown): string | undefined {
  const m = meta as
    | { terminal_output?: { data?: unknown }; terminal_exit?: { exit_code?: unknown } }
    | undefined;
  if (!m || typeof m !== 'object') return undefined;
  const data = typeof m.terminal_output?.data === 'string' ? m.terminal_output.data : '';
  const exit = m.terminal_exit?.exit_code;
  if (!data) return typeof exit === 'number' ? `[exit code: ${exit}]` : undefined;
  return typeof exit === 'number' ? `${data}\n[exit code: ${exit}]` : data;
}

/**
 * Extract the model list from a `session/new` | `session/load` response. ACP
 * agents expose it two ways and we support both:
 *   - `source: 'models'` — the experimental top-level `models` field (the
 *     easy-code backend), switched via `session/set_model`;
 *   - `source: 'configOptions'` — a `model` entry inside `configOptions` (the
 *     claude-agent-acp / codex-acp bridges, which do NOT emit `models` and
 *     reject `session/set_model` with -32601), switched via
 *     `session/set_config_option` with `configId: 'model'`.
 */
function modelsOf(resp: unknown): {
  available: ModelInfo[];
  current?: string;
  source: 'models' | 'configOptions';
} {
  // Preferred: the experimental top-level `models` field.
  const ms = (resp as { models?: { availableModels?: unknown; currentModelId?: unknown } }).models;
  if (ms && Array.isArray(ms.availableModels)) {
    const available: ModelInfo[] = [];
    for (const m of ms.availableModels as Array<Record<string, unknown>>) {
      if (typeof m.modelId === 'string') {
        available.push({ modelId: m.modelId, name: typeof m.name === 'string' ? m.name : m.modelId });
      }
    }
    if (available.length) {
      const current = typeof ms.currentModelId === 'string' ? ms.currentModelId : undefined;
      return { available, current, source: 'models' };
    }
  }
  // Fallback: the `model` entry of configOptions (claude-agent-acp / codex).
  const cfg = (resp as { configOptions?: unknown }).configOptions;
  if (Array.isArray(cfg)) {
    const modelOpt = cfg.find(
      (o) => o && typeof o === 'object' && (o as { id?: unknown }).id === 'model',
    ) as { currentValue?: unknown; options?: unknown } | undefined;
    if (modelOpt && Array.isArray(modelOpt.options)) {
      const available: ModelInfo[] = [];
      for (const o of modelOpt.options as Array<Record<string, unknown>>) {
        if (typeof o.value === 'string') {
          available.push({ modelId: o.value, name: typeof o.name === 'string' ? o.name : o.value });
        }
      }
      if (available.length) {
        const current =
          typeof modelOpt.currentValue === 'string' ? modelOpt.currentValue : undefined;
        return { available, current, source: 'configOptions' };
      }
    }
  }
  return { available: [], current: undefined, source: 'models' };
}

function modeOf(resp: unknown): string | undefined {
  const modes = (resp as { modes?: { currentModeId?: unknown } }).modes;
  return typeof modes?.currentModeId === 'string' ? modes.currentModeId : undefined;
}

/**
 * Pick the most permissive "allow" option from a permission request, mirroring
 * the CLI's headless auto-approval (see `pickAllowOption` in
 * packages/core/src/acp-client/acpAgentClient.ts). Prefers `allow_always`, then
 * `allow_once`, then any non-reject option.
 */
function pickAllowOption(
  options: acp.PermissionOption[],
): acp.PermissionOption | undefined {
  return (
    options.find((o) => o.kind === 'allow_always') ??
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => o.kind !== 'reject_once' && o.kind !== 'reject_always')
  );
}

/** The ACP Client half: handles agent-initiated requests + session updates. */
class DesktopAcpClient implements acp.Client {
  constructor(
    private readonly sessionId: () => string,
    private readonly cb: BridgeCallbacks,
    /** Current session permission mode; consulted on each permission request. */
    private readonly mode: () => PermissionMode,
    /**
     * When true, every permission request is auto-approved without prompting the
     * user — the GUI counterpart of the CLI/Feishu delegate path, which spawns
     * the very same ACP bridge with `runDelegatedTask({ autoApprove: true })`
     * (see core/src/tools/delegate-agent.ts). Used for external agents (Claude
     * Code / Codex): they run their own approval flow and the desktop does not
     * manage their permission mode (see sessionHub.create), so forwarding their
     * requestPermission to a dialog would be a UX regression vs. Feishu.
     */
    private readonly autoApprove: () => boolean,
  ) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-approve when the backend is configured to always auto-approve
    // (external agents) or the session is in YOLO mode: select the most
    // permissive allow option without bothering the user, exactly like the
    // CLI's headless runDelegatedTask({ autoApprove: true }). `default` mode on
    // Easy Code still prompts the UI.
    if (this.autoApprove() || this.mode() === 'yolo') {
      const option = pickAllowOption(params.options);
      if (option) {
        const title = params.toolCall?.title ?? 'tool call';
        this.cb.log(`auto-approve: ${title}`);
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      }
      // No allow option offered — fall through to the interactive flow below.
    }

    this.cb.setStatus('needs_approval');
    const response = await this.cb.requestPermission({
      toolCallId: params.toolCall?.toolCallId ?? '',
      title: params.toolCall?.title ?? 'tool call',
      toolKind: (params.toolCall?.kind as AcpToolKind) ?? 'other',
      options: params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind as PermissionRequest['options'][number]['kind'],
      })),
      content: normalizeToolContent(
        (params.toolCall as { content?: unknown } | undefined)?.content,
      ),
    });
    this.cb.setStatus('thinking');
    if (response.outcome === 'cancelled') {
      return { outcome: { outcome: 'cancelled' } };
    }
    return { outcome: { outcome: 'selected', optionId: response.optionId } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update as Record<string, unknown> & { sessionUpdate: string };
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = textOfContent(u.content);
        if (!t) break;
        // Core encodes mode/model switches and the auto-generated session title
        // as markers inside message chunks (see acpSession.ts in the backend).
        if (t.startsWith('[MODE_UPDATE]') || t.startsWith('[Model switched')) {
          this.cb.emit({ kind: 'mode_marker', mode: t });
        } else if (t.startsWith('[TITLE_UPDATE]')) {
          const title = t.slice('[TITLE_UPDATE]'.length).trim();
          if (title) this.cb.emit({ kind: 'title', title });
        } else {
          this.cb.emit({ kind: 'message_chunk', text: t });
        }
        break;
      }
      case 'agent_thought_chunk': {
        const t = textOfContent(u.content);
        if (t) this.cb.emit({ kind: 'thought_chunk', text: t });
        break;
      }
      case 'user_message_chunk': {
        const t = textOfContent(u.content);
        if (t) this.cb.emit({ kind: 'user_chunk', text: t });
        break;
      }
      case 'tool_call': {
        this.cb.emit({
          kind: 'tool_call',
          toolCallId: String(u.toolCallId ?? ''),
          title: String(u.title ?? ''),
          toolKind: (u.kind as AcpToolKind) ?? 'other',
          status: 'pending',
          locations: Array.isArray(u.locations)
            ? (u.locations as Array<{ path: string; line?: number }>).map((l) => ({
                path: l.path,
                line: l.line,
              }))
            : undefined,
          content: normalizeToolContent(u.content),
        });
        break;
      }
      case 'tool_call_update': {
        const status =
          u.status === 'pending' ||
          u.status === 'in_progress' ||
          u.status === 'completed' ||
          u.status === 'failed'
            ? u.status
            : undefined;
        this.cb.emit({
          kind: 'tool_update',
          toolCallId: String(u.toolCallId ?? ''),
          status,
          title: typeof u.title === 'string' ? u.title : undefined,
          content: normalizeToolContent(u.content),
          terminalOutput: terminalFromMeta((u as { _meta?: unknown })._meta),
        });
        break;
      }
      case 'plan': {
        const entries = Array.isArray(u.entries)
          ? (u.entries as Array<{ content: string; status: string }>).map((e) => ({
              content: e.content,
              status:
                e.status === 'completed' || e.status === 'in_progress'
                  ? (e.status as 'completed' | 'in_progress')
                  : ('pending' as const),
            }))
          : [];
        this.cb.emit({ kind: 'plan', entries });
        break;
      }
      case 'usage_update': {
        this.cb.emit({
          kind: 'usage',
          used: Number(u.used ?? 0),
          size: Number(u.size ?? 0),
        });
        break;
      }
      case 'available_commands_update': {
        const cmds = Array.isArray(u.availableCommands)
          ? (u.availableCommands as Array<{ name: string; description?: string }>).map((c) => ({
              name: c.name,
              description: c.description ?? '',
            }))
          : [];
        this.cb.emit({ kind: 'commands', commands: cmds });
        break;
      }
      default:
        break;
    }
  }

  async readTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    let content = await fs.readFile(params.path, 'utf8');
    if (
      (params.line != null && params.line > 1) ||
      (params.limit != null && params.limit >= 0)
    ) {
      const lines = content.split('\n');
      const start = params.line != null ? Math.max(0, params.line - 1) : 0;
      const end = params.limit != null ? start + params.limit : lines.length;
      content = lines.slice(start, end).join('\n');
    }
    return { content };
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    await fs.mkdir(path.dirname(params.path), { recursive: true });
    await fs.writeFile(params.path, params.content, 'utf8');
    return {};
  }
}

export interface StartResult {
  acpSessionId: string;
  availableModels: ModelInfo[];
  model?: string;
  mode: PermissionMode;
}

export class AcpSessionBridge {
  private child?: ChildProcess;
  private connection?: acp.ClientSideConnection;
  private acpSessionId?: string;
  private pendingPromptAbort?: AbortController;
  private disposed = false;
  /**
   * Latest permission mode for this session. Read by the ACP client on each
   * `requestPermission` to decide whether to auto-approve (yolo) or prompt the
   * UI (default). Kept in sync by {@link start} and {@link setMode}.
   */
  private currentMode: PermissionMode = 'default';
  /**
   * Which ACP surface this agent advertised its models on (see {@link modelsOf}).
   * Read by {@link setModel} to pick the right switch RPC. Set in {@link start}.
   */
  private modelSource: 'models' | 'configOptions' = 'models';

  constructor(
    readonly id: string,
    private readonly cwd: string,
    private readonly cb: BridgeCallbacks,
    /** Which agent backend to drive. Defaults to the bundled Easy Code. */
    private readonly agentType: AgentKind = 'easy-code',
  ) {}

  /** Spawn the backend, establish the ACP connection, create or resume a session. */
  async start(resumeSessionId?: string): Promise<StartResult> {
    this.cb.setStatus('starting');
    // Easy Code runs the bundled backend directly; external agents (Claude
    // Code / Codex) are driven through their `npx` ACP bridges. Either way the
    // spawned process speaks ACP over stdio, so everything below is identical.
    const spec =
      this.agentType === 'easy-code'
        ? buildBackendSpec()
        : buildExternalAgentSpec(this.agentType);
    this.cb.log(`spawn: ${spec.description}`);

    const child = spawn(spec.command, spec.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...spec.env },
      shell: spec.shell ?? false,
    });
    this.child = child;

    // Keep a short tail of stderr so a startup crash produces a useful error
    // instead of a silent hang.
    let stderrTail = '';
    let handshakeDone = false;
    let onEarlyExit: ((err: Error) => void) | undefined;
    // Rejects if the backend dies before the ACP handshake finishes. Without
    // this, a crashed backend leaves `connection.initialize()` pending forever
    // and the UI spins indefinitely (no response ever arrives on the closed
    // stdout stream).
    const earlyExit = new Promise<never>((_, reject) => {
      onEarlyExit = reject;
    });
    // Swallow the unhandled-rejection if the handshake wins the race.
    earlyExit.catch(() => undefined);

    child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stderrTail = (stderrTail + s).slice(-2000);
      this.cb.log(s);
    });
    child.stdin?.on('error', () => undefined);
    child.on('exit', (code) => {
      if (this.disposed) return;
      this.cb.log(`backend exited (code ${code ?? 'null'})`);
      this.cb.setStatus('exited');
      if (!handshakeDone) {
        const tail = stderrTail.trim();
        onEarlyExit?.(
          new Error(
            `Easy Code 后端在初始化前退出（code ${code ?? 'null'}）。` +
              (tail ? `\n后端输出：\n${tail}` : ''),
          ),
        );
      }
    });

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to open stdio pipes for the backend.');
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const handler = new DesktopAcpClient(
      () => this.acpSessionId ?? this.id,
      this.cb,
      () => this.currentMode,
      // External agents (Claude Code / Codex) auto-approve unconditionally,
      // matching the Feishu/CLI delegate path. Easy Code keeps the interactive
      // default/yolo gate driven by `currentMode`.
      () => this.agentType !== 'easy-code',
    );
    const connection = new acp.ClientSideConnection(() => handler, stream);
    this.connection = connection;

    // Run the whole ACP handshake as one unit, racing it against an early
    // backend exit so a crashed/incompatible backend surfaces as an error
    // rather than an endless spinner.
    const handshake = async (): Promise<unknown> => {
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
          _meta: { terminal_output: true },
        },
      });

      // Credentials live in the shared on-disk store the backend reads on
      // startup, so newSession works without an explicit authenticate round-trip.
      let r: unknown;
      if (resumeSessionId) {
        try {
          r = await connection.loadSession({
            sessionId: resumeSessionId,
            cwd: this.cwd,
            mcpServers: [],
          });
          this.acpSessionId = resumeSessionId;
        } catch (err) {
          this.cb.log(`loadSession failed, starting fresh: ${String(err)}`);
        }
      }
      if (!this.acpSessionId) {
        const created = await connection.newSession({ cwd: this.cwd, mcpServers: [] });
        this.acpSessionId = created.sessionId;
        r = created;
      }
      return r;
    };

    const resp = await Promise.race([handshake(), earlyExit]);
    handshakeDone = true;

    const { available, current, source } = modelsOf(resp);
    this.modelSource = source;
    const mode = fromApprovalModeId(modeOf(resp));
    this.currentMode = mode;
    this.cb.setStatus('idle');
    return {
      acpSessionId: this.acpSessionId!,
      availableModels: available,
      model: current,
      mode,
    };
  }

  async prompt(
    text: string,
    atPaths: string[] = [],
    images: { mimeType: string; data: string }[] = [],
  ): Promise<void> {
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started.');
    }
    this.pendingPromptAbort?.abort();
    const abort = new AbortController();
    this.pendingPromptAbort = abort;

    const prompt: acp.ContentBlock[] = [{ type: 'text', text }];
    for (const p of atPaths) {
      prompt.push({
        type: 'resource_link',
        uri: pathToFileURL(p).href,
        name: path.basename(p),
      } as acp.ContentBlock);
    }
    for (const img of images) {
      prompt.push({ type: 'image', mimeType: img.mimeType, data: img.data } as acp.ContentBlock);
    }

    this.cb.setStatus('thinking');
    this.cb.emit({ kind: 'turn_start' });
    try {
      const res = await this.connection.prompt({ sessionId: this.acpSessionId, prompt });
      this.cb.emit({ kind: 'turn_end', stopReason: res.stopReason });
      this.cb.setStatus('idle');
    } catch (err) {
      if (abort.signal.aborted) {
        this.cb.emit({ kind: 'turn_end', stopReason: 'cancelled' });
        this.cb.setStatus('idle');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.cb.emit({ kind: 'error', message });
      this.cb.setStatus('error');
    } finally {
      if (this.pendingPromptAbort === abort) this.pendingPromptAbort = undefined;
    }
  }

  async cancel(): Promise<void> {
    this.pendingPromptAbort?.abort();
    if (this.connection && this.acpSessionId) {
      await this.connection.cancel({ sessionId: this.acpSessionId }).catch(() => undefined);
    }
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.connection || !this.acpSessionId) return;
    if (this.modelSource === 'configOptions') {
      // claude-agent-acp / codex expose models via configOptions and reject
      // session/set_model (-32601); switch via session/set_config_option.
      await this.connection.setSessionConfigOption({
        sessionId: this.acpSessionId,
        configId: 'model',
        value: modelId,
      });
    } else {
      await this.connection.unstable_setSessionModel({
        sessionId: this.acpSessionId,
        modelId,
      });
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    // Record locally first so client-side auto-approval (yolo) takes effect even
    // if the backend ignores setSessionMode (e.g. an external agent bridge).
    this.currentMode = mode;
    if (!this.connection || !this.acpSessionId) return;
    await this.connection
      .setSessionMode({ sessionId: this.acpSessionId, modeId: toApprovalModeId(mode) })
      .catch((err) => this.cb.log(`setSessionMode failed: ${String(err)}`));
  }

  async rewind(beforeUserMessageIndex: number): Promise<{
    keptUserMessageCount: number;
    droppedContentCount: number;
  }> {
    if (!this.connection || !this.acpSessionId) {
      return { keptUserMessageCount: 0, droppedContentCount: 0 };
    }
    const res = (await this.connection.extMethod('_dvcode/session/rewind', {
      sessionId: this.acpSessionId,
      beforeUserMessageIndex,
    })) as { keptUserMessageCount?: number; droppedContentCount?: number };
    return {
      keptUserMessageCount: res.keptUserMessageCount ?? 0,
      droppedContentCount: res.droppedContentCount ?? 0,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.pendingPromptAbort?.abort();
    try {
      if (this.child && !this.child.killed) {
        if (os.platform() === 'win32' && this.child.pid) {
          spawn('taskkill', ['/pid', String(this.child.pid), '/f', '/t']);
        } else {
          this.child.kill('SIGTERM');
        }
      }
    } catch {
      /* best effort */
    }
    this.child = undefined;
    this.connection = undefined;
  }
}
