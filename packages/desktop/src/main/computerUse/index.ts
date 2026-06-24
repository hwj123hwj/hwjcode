/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * `ComputerUseManager` — the desktop side of the computer-use feature.
 *
 * It hosts an in-process MCP server (Streamable HTTP, localhost, token-gated)
 * that exposes a single `computer` tool mirroring Claude's `computer_20251124`
 * action set. The agent in a spawned `easycode --acp` backend discovers this
 * tool (injected via the desktop-only system-settings file — see paths.ts) and
 * drives the real desktop through {@link ComputerUseExecutor}.
 *
 * Safety lives here, not in the headless tool:
 *   - OFF by default; the MCP entry is written to the settings file only while
 *     enabled, so a disabled toggle means the tool isn't even advertised to
 *     newly-spawned backends.
 *   - Every call re-checks `enabled` and a live kill-switch (`requestStop`).
 *   - `onActivity` drives a visible "Easy Code is controlling your computer"
 *     overlay while a turn is touching the screen.
 *   - Tool calls are NOT auto-trusted, so they flow through the normal ACP
 *     permission gate (the user can "always allow" once per session).
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ComputerUseExecutor,
  type ActionResult,
  type ComputerAction,
  type ComputerActionParams,
} from './executor.js';
import { COMPUTER_USE_SERVER_NAME, desktopSystemSettingsPath } from './paths.js';
import type { ComputerUseStatus } from '../../shared/ipc.js';

const TOOL_NAME = 'computer';

/** Real executor actions (each maps to one OS event). */
const ACTIONS: ComputerAction[] = [
  'screenshot',
  'cursor_position',
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'left_click_path',
  'type',
  'key',
  'scroll',
  'wait',
];

/** `batch` is a manager-level meta-action: it runs a list of the above steps
 *  back-to-back against the current screen and screenshots only once at the end. */
const TOOL_ACTIONS = [...ACTIONS, 'batch'];

/** Hard cap on steps in a single batch — keeps one blind run bounded. */
const MAX_BATCH_STEPS = 60;

const TOOL_DESCRIPTION = [
  'Control THIS computer like a human: see the screen and operate any application',
  '(desktop apps, browsers, settings, drawing tools) with the real mouse and keyboard.',
  '',
  'Loop: call with action="screenshot" to see the screen, act, then screenshot',
  'again only when you need to verify the result.',
  '',
  'BE ECONOMICAL WITH SCREENSHOTS. Capturing the screen after every action is slow',
  'and burns tokens. When you can predict the outcome of a run of actions from the',
  'current screen (a deterministic sequence — e.g. open a tool, set the brush size,',
  'then draw several strokes), do NOT screenshot between them:',
  '  • Prefer action="batch": pass a `steps` array of actions that all execute',
  '    back-to-back against the CURRENT screen; you get ONE screenshot at the end.',
  '    Every step\'s coordinates are in the SAME last-screenshot space, so only',
  '    batch steps you can plan from what you currently see.',
  '  • Or set `screenshot: false` on a single action to skip its screenshot.',
  'Then screenshot once at a checkpoint to confirm, and fix only if it looks wrong.',
  'Screenshot after an action when the result is uncertain (navigation, dialogs,',
  'anything whose outcome you cannot predict).',
  '',
  'IMPORTANT: every screenshot is returned to you as an inline image — view it',
  'directly with your own vision. Never call image_reader, read_many_files, or any',
  'image-description tool on a screenshot: you can already see it, and offloading it',
  'to a describer is slow, lossy, and strips the pixel coordinates you click with.',
  '',
  'Coordinates are pixels in the LAST screenshot you received (its width/height are',
  'reported with each capture). Origin (0,0) is the top-left.',
  '',
  'Actions:',
  '- batch: run `steps` (array of action objects) in order with no screenshots',
  '  between them, returning one screenshot at the end. Use for deterministic runs.',
  '- screenshot: capture the current screen.',
  '- left_click / right_click / middle_click / double_click / triple_click: click at `coordinate`.',
  '  Hold modifiers by setting `text` (e.g. "ctrl" or "shift").',
  '- mouse_move: move the cursor to `coordinate` without clicking.',
  '- left_mouse_down / left_mouse_up: fine-grained press/release at `coordinate`.',
  '- left_click_drag: press at `start_coordinate`, release at `coordinate`.',
  '- left_click_path: freehand stroke through `path` (array of [x,y]) with the button held — use this to draw.',
  '- type: type the string in `text` into the focused field.',
  '- key: press a key combo in `text`, e.g. "ctrl+s", "Return", "alt+Tab", "Page_Down".',
  '- scroll: scroll at `coordinate` in `scroll_direction` by `scroll_amount` clicks.',
  '- wait: pause for `duration` seconds to let the UI settle.',
  '- cursor_position: report the current cursor location.',
].join('\n');

/** Fields shared by a top-level call and a single batch step. */
const STEP_PROPERTIES = {
  action: { type: 'string', enum: ACTIONS, description: 'The UI action to perform.' },
  coordinate: {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    maxItems: 2,
    description: '[x, y] target in last-screenshot pixel space.',
  },
  start_coordinate: {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    maxItems: 2,
    description: '[x, y] drag origin for left_click_drag.',
  },
  path: {
    type: 'array',
    items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    description: 'Polyline of [x, y] points for left_click_path (drawing).',
  },
  text: { type: 'string', description: 'Text to type, key combo to press, or modifier keys to hold.' },
  scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
  scroll_amount: { type: 'number', description: 'Number of scroll clicks (default 3).' },
  duration: { type: 'number', description: 'Seconds to wait (action="wait").' },
} as const;

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    ...STEP_PROPERTIES,
    // Top-level `action` also allows "batch", which the step-level one does not.
    action: { type: 'string', enum: TOOL_ACTIONS, description: 'The UI action to perform.' },
    screenshot: {
      type: 'boolean',
      description:
        'Whether to return a screenshot after this action (default true). Set false to skip it during a deterministic run and stay fast/cheap.',
    },
    steps: {
      type: 'array',
      description:
        'For action="batch": the actions to run back-to-back against the current screen. One screenshot is returned after the last step.',
      maxItems: MAX_BATCH_STEPS,
      items: {
        type: 'object',
        properties: STEP_PROPERTIES,
        required: ['action'],
      },
    },
  },
  required: ['action'],
} as const;

export interface ComputerUseManagerOptions {
  /** Initial enabled state (persisted in the shared user settings). */
  initialEnabled: boolean;
  /** Persist the enabled flag back to the shared user settings. */
  persistEnabled: (enabled: boolean) => void;
  /** Fired whenever the status (enabled/active) changes, to update the UI/overlay. */
  onStatus: (status: ComputerUseStatus) => void;
  /** Diagnostic log sink (shares the backend-log channel). */
  log: (line: string) => void;
}

export class ComputerUseManager {
  private readonly executor = new ComputerUseExecutor();
  private readonly token = randomUUID();
  private server?: http.Server;
  private port = 0;
  private enabled: boolean;
  private active = false;
  /** Debounce timer that clears `active` after the last screen-touching action. */
  private activeTimer?: NodeJS.Timeout;
  /** Live kill-switch for in-flight executor actions. Replaced after each stop. */
  private abort = new AbortController();
  private inFlight = 0;

  constructor(private readonly opts: ComputerUseManagerOptions) {
    this.enabled = opts.initialEnabled;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /** Start the localhost MCP server and write the settings file for backends. */
  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      // Bind to loopback only — never expose desktop control to the network.
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    this.opts.log(`computer-use MCP server on 127.0.0.1:${this.port} (enabled=${this.enabled})`);
    this.writeSettingsFile();
  }

  dispose(): void {
    this.abort.abort();
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.server?.close();
    this.server = undefined;
  }

  // ── state ────────────────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.enabled;
  }

  getStatus(): ComputerUseStatus {
    return { enabled: this.enabled, active: this.active, available: true };
  }

  setEnabled(enabled: boolean): ComputerUseStatus {
    if (this.enabled === enabled) return this.getStatus();
    this.enabled = enabled;
    this.opts.persistEnabled(enabled);
    this.writeSettingsFile();
    if (!enabled) this.requestStop();
    this.opts.log(`computer-use ${enabled ? 'enabled' : 'disabled'}`);
    this.emitStatus();
    return this.getStatus();
  }

  /** Kill-switch: abort any in-flight action and arm a fresh controller. */
  requestStop(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.setActive(false);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private emitStatus(): void {
    this.opts.onStatus(this.getStatus());
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.emitStatus();
  }

  private markActivity(): void {
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.setActive(true);
    // Stay up for the WHOLE turn — the primary clear is noteTurnIdle() when the
    // session finishes. A short per-action debounce made the overlay flicker on
    // every think/approve/screenshot gap; this long timer is only a safety net
    // for the rare case where we never hear the turn end.
    this.activeTimer = setTimeout(() => {
      if (this.inFlight === 0) this.setActive(false);
    }, 120000);
  }

  /**
   * A session's turn ended (went idle). Drop the overlay so it isn't pinned
   * forever, but never while an action is still in flight.
   */
  noteTurnIdle(): void {
    if (this.inFlight > 0) return;
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.setActive(false);
  }

  /** Path is fixed; content carries the MCP entry only while enabled. */
  private writeSettingsFile(): void {
    const fp = desktopSystemSettingsPath();
    const content = this.enabled
      ? {
          mcpServers: {
            [COMPUTER_USE_SERVER_NAME]: {
              httpUrl: `http://127.0.0.1:${this.port}/mcp`,
              headers: { 'x-cu-token': this.token },
              timeout: 600000,
              description:
                'Easy Code Desktop — control this computer (screenshots, mouse, keyboard).',
            },
          },
        }
      : {};
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(content, null, 2), 'utf-8');
      fs.renameSync(tmp, fp);
    } catch (err) {
      this.opts.log(`failed to write computer-use settings file: ${String(err)}`);
    }
  }

  // ── HTTP / MCP plumbing ──────────────────────────────────────────────────

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || url !== '/mcp') {
      res.writeHead(405).end();
      return;
    }
    if (req.headers['x-cu-token'] !== this.token) {
      res.writeHead(401).end();
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // Stateless: a fresh MCP server + transport per request. The executor and
    // safety state are shared via the closure, so this stays cheap.
    const server = this.buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      this.opts.log(`computer-use request error: ${String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private buildMcpServer(): Server {
    const server = new Server(
      { name: COMPUTER_USE_SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: TOOL_NAME,
          description: TOOL_DESCRIPTION,
          inputSchema: TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>,
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== TOOL_NAME) {
        return errorResult(`Unknown tool: ${request.params.name}`);
      }
      if (!this.enabled) {
        return errorResult(
          'Computer use is disabled. Ask the user to enable it in Settings → Computer Use.',
        );
      }
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const action = args.action as ComputerAction | 'batch';
      if (action !== 'batch' && (!action || !ACTIONS.includes(action as ComputerAction))) {
        return errorResult(`Missing or invalid "action" (got ${JSON.stringify(args.action)}).`);
      }

      this.inFlight++;
      this.markActivity();
      try {
        const result =
          action === 'batch'
            ? await this.runBatch(args.steps)
            : await this.executor.execute(action, paramsFrom(args), this.abort.signal, {
                screenshot: args.screenshot !== false,
              });
        return { content: contentFrom(result) };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      } finally {
        this.inFlight--;
        this.markActivity();
      }
    });

    return server;
  }

  /**
   * Run a list of steps back-to-back against the current screen, capturing a
   * single screenshot at the end. No screenshots between steps — that's the
   * whole point: a deterministic run costs one image instead of N. If a step
   * fails (or the user stops), we stop early and still return the resulting
   * screen so the model can see how far it got and correct.
   */
  private async runBatch(rawSteps: unknown): Promise<ActionResult> {
    const list = maybeJson(rawSteps);
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('batch needs a non-empty "steps" array.');
    }
    if (list.length > MAX_BATCH_STEPS) {
      throw new Error(`batch is limited to ${MAX_BATCH_STEPS} steps (got ${list.length}).`);
    }

    const done: string[] = [];
    let failure: string | undefined;
    for (let i = 0; i < list.length; i++) {
      if (this.abort.signal.aborted) {
        failure = 'Stopped by the user.';
        break;
      }
      const step = (list[i] ?? {}) as Record<string, unknown>;
      const stepAction = step.action as ComputerAction;
      if (!stepAction || !ACTIONS.includes(stepAction)) {
        failure = `step ${i + 1}: invalid action ${JSON.stringify(step.action)}.`;
        break;
      }
      try {
        // Each step is silent; we observe only at the end.
        const r = await this.executor.execute(stepAction, paramsFrom(step), this.abort.signal, {
          screenshot: false,
        });
        done.push(`${i + 1}. ${r.text}`);
      } catch (err) {
        failure = `step ${i + 1} (${stepAction}): ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }

    // Observe the final state regardless of success/failure.
    const final = await this.executor.execute('screenshot', {}, this.abort.signal);
    const header = failure
      ? `Batch stopped after ${done.length}/${list.length} steps — ${failure}`
      : `Batch complete: ran ${done.length} steps.`;
    return { text: [header, ...done].join('\n'), screenshot: final.screenshot };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function errorResult(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Coerce a record of model-supplied args into {@link ComputerActionParams}. */
function paramsFrom(args: Record<string, unknown>): ComputerActionParams {
  return {
    coordinate: toPair(args.coordinate),
    start_coordinate: toPair(args.start_coordinate),
    path: toPath(args.path),
    text: typeof args.text === 'string' ? args.text : undefined,
    scroll_direction: args.scroll_direction as ComputerActionParams['scroll_direction'],
    scroll_amount: typeof args.scroll_amount === 'number' ? args.scroll_amount : undefined,
    duration: typeof args.duration === 'number' ? args.duration : undefined,
  };
}

/** Build the MCP content array for an action result (text + optional image). */
function contentFrom(result: ActionResult): Array<Record<string, unknown>> {
  if (!result.screenshot) return [{ type: 'text', text: result.text }];
  return [
    {
      type: 'text',
      text:
        `${result.text}\n` +
        `Screenshot is ${result.screenshot.width}×${result.screenshot.height}px; give coordinates in this space.\n` +
        `This image is attached below — look at it directly and decide your next action. ` +
        `Do NOT call image_reader, read_many_files, or any image-description tool on it: ` +
        `you can already see it, and routing screenshots through a describer is slow, lossy, ` +
        `and loses the pixel coordinates you need to click.`,
    },
    {
      type: 'image',
      data: result.screenshot.data,
      mimeType: result.screenshot.mimeType,
    },
  ];
}

/** Parse a value the model may have JSON-encoded as a string (common for the
 *  nested-array `path` and even for coordinates). Returns the value unchanged
 *  if it isn't a JSON string. */
function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return v;
  // Only attempt a parse for things that look like JSON containers/numbers, so
  // we never misinterpret e.g. a `text` value that happens to be a string.
  if (!/^[[{\d.+-]/.test(s)) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

/** Coerce to a finite number, accepting numeric strings ("100", "12.5"). */
function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Coerce a model-supplied value into an [x, y] pixel pair. Tolerant of the
 * shapes different models emit: a real `[x, y]` array, a `{x, y}` object,
 * numeric strings inside either, or a JSON string of any of those.
 */
function toPair(v: unknown): [number, number] | undefined {
  const val = maybeJson(v);
  if (Array.isArray(val) && val.length === 2) {
    const x = toNum(val[0]);
    const y = toNum(val[1]);
    if (x != null && y != null) return [x, y];
    return undefined;
  }
  if (val && typeof val === 'object') {
    const o = val as Record<string, unknown>;
    const x = toNum(o.x);
    const y = toNum(o.y);
    if (x != null && y != null) return [x, y];
  }
  return undefined;
}

/**
 * Coerce a model-supplied value into a polyline of [x, y] pairs. Accepts the
 * declared `[[x,y],...]` shape plus the variants models actually produce: a
 * JSON-string of the array, a flat `[x0,y0,x1,y1,...]` array, or points given
 * as `{x,y}` objects.
 */
function toPath(v: unknown): Array<[number, number]> | undefined {
  const val = maybeJson(v);
  if (!Array.isArray(val) || val.length === 0) return undefined;

  // Flat numeric array: [x0, y0, x1, y1, ...] → chunk into pairs.
  if (val.every((n) => toNum(n) != null)) {
    const nums = val.map((n) => toNum(n) as number);
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
    return out.length ? out : undefined;
  }

  // Array of points, each [x,y] / {x,y} / JSON-string thereof.
  const out: Array<[number, number]> = [];
  for (const p of val) {
    const pair = toPair(p);
    if (pair) out.push(pair);
  }
  return out.length ? out : undefined;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Screenshots flow OUT, not in; an inbound body this large is bogus.
      if (size > 8 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
