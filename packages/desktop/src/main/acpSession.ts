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
import type {
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

function modelsOf(resp: unknown): {
  available: ModelInfo[];
  current?: string;
} {
  const ms = (resp as { models?: { availableModels?: unknown; currentModelId?: unknown } }).models;
  const availableRaw = Array.isArray(ms?.availableModels) ? ms!.availableModels : [];
  const available: ModelInfo[] = [];
  for (const m of availableRaw as Array<Record<string, unknown>>) {
    if (typeof m.modelId === 'string') {
      available.push({ modelId: m.modelId, name: typeof m.name === 'string' ? m.name : m.modelId });
    }
  }
  const current = typeof ms?.currentModelId === 'string' ? ms.currentModelId : undefined;
  return { available, current };
}

function modeOf(resp: unknown): string | undefined {
  const modes = (resp as { modes?: { currentModeId?: unknown } }).modes;
  return typeof modes?.currentModeId === 'string' ? modes.currentModeId : undefined;
}

/** The ACP Client half: handles agent-initiated requests + session updates. */
class DesktopAcpClient implements acp.Client {
  constructor(
    private readonly sessionId: () => string,
    private readonly cb: BridgeCallbacks,
  ) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
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
        // Core encodes mode/model switches as markers inside message chunks.
        if (t.startsWith('[MODE_UPDATE]') || t.startsWith('[Model switched')) {
          this.cb.emit({ kind: 'mode_marker', mode: t });
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

  constructor(
    readonly id: string,
    private readonly cwd: string,
    private readonly cb: BridgeCallbacks,
  ) {}

  /** Spawn the backend, establish the ACP connection, create or resume a session. */
  async start(resumeSessionId?: string): Promise<StartResult> {
    this.cb.setStatus('starting');
    const spec = buildBackendSpec();
    this.cb.log(`spawn: ${spec.description}`);

    const child = spawn(spec.command, spec.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...spec.env },
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
    const handler = new DesktopAcpClient(() => this.acpSessionId ?? this.id, this.cb);
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

    const { available, current } = modelsOf(resp);
    const mode = fromApprovalModeId(modeOf(resp));
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
    await this.connection.unstable_setSessionModel({ sessionId: this.acpSessionId, modelId });
  }

  async setMode(mode: PermissionMode): Promise<void> {
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
