/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import {
  BaseTool,
  Icon,
  ToolResult,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolConfirmationOutcome,
} from './tools.js';
import { Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** Throttle interval for pushing live output to the UI. */
const OUTPUT_UPDATE_INTERVAL_MS = 500;

/**
 * Default per-command watchdog. OpenCLI browser primitives are interactive but
 * short-lived — a `state`/`click`/`type` returns in well under a second; only a
 * hung CDP attach or a `wait` lingers. Unlike lark-cli's device-flow login,
 * nothing here blocks for minutes (auth happens out-of-band in real Chrome), so
 * we keep the ceiling tight (30–60s) and let `wait` callers raise it via the
 * `timeout` param.
 */
const DEFAULT_TIMEOUT_S = 45;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 120;

/** Short timeout for the daemon health preflight (it hits localhost only). */
const PREFLIGHT_TIMEOUT_MS = 8000;

/**
 * The package the tool drives, pinned to `@latest` so the `npm install -g` hint
 * we surface when opencli is missing (and the opt-in npx fallback) always pull
 * the newest release rather than a version that drifts stale in this source.
 */
const OPENCLI_PACKAGE = '@jackwener/opencli@latest';

/**
 * Top-level commands that are pure CLI/daemon infrastructure and therefore do
 * NOT need the browser-stack preflight (running one would be redundant, and for
 * `daemon`/`doctor` it would recurse into the very thing we are checking).
 */
const NO_PREFLIGHT_TOP = new Set([
  'doctor',
  'daemon',
  'version',
  '--version',
  '-v',
  'help',
  '--help',
  '-h',
  'completion',
  'config',
  'profile',
  'skills',
  'auth',
]);

/**
 * Read-only `browser` verbs. Everything else under `browser` mutates the page
 * (or submits data) and must pass the write-confirmation gate. Keep this list
 * authoritative: the gate fails closed, so an unrecognised verb is treated as a
 * write.
 */
const READ_BROWSER_VERBS = new Set([
  'state',
  'find',
  'frames',
  'screenshot',
  'get',
  'eval', // documented read-only (IIFE returning JSON; no DOM mutation)
  'network',
  'extract',
  'analyze',
  'title',
  'url',
  'wait', // waits for a condition; does not mutate
]);

/**
 * Top-level commands that are read-only as a whole (no subcommand inspection
 * needed). Anything not listed here, and not a read `browser` verb, requires
 * confirmation.
 */
const READ_TOP = new Set([
  'doctor',
  'version',
  '--version',
  '-v',
  'help',
  '--help',
  '-h',
  'completion',
]);

/** How the tool resolves and launches the opencli binary. */
interface OpenCliInvocation {
  command: string;
  baseArgs: string[];
  shell: boolean;
}

/**
 * Outcome of resolving how to launch opencli: either a usable invocation, or a
 * classified reason we could not (so the caller can fail with an actionable
 * hint instead of guessing).
 */
type InvocationResolution =
  | { invocation: OpenCliInvocation }
  | { invocation: null; kind: OpenCliErrorKind; message: string };

/** Raw outcome of a single child-process run, before classification. */
interface RawRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process failed to even launch (spawn error). */
  launchError?: string;
}

/** Machine-readable classification of an opencli failure. */
export type OpenCliErrorKind =
  | 'daemon-not-running'
  | 'extension-not-connected'
  | 'not-logged-in'
  | 'stale-ref'
  | 'selector'
  | 'cdp-detached'
  | 'timeout'
  | 'empty'
  | 'aborted'
  | 'launch-error'
  | 'not-installed'
  | 'unknown';

/** Parameters for the OpenCliTool. */
export interface OpenCliParams {
  /**
   * The complete opencli argument vector, e.g.
   * `["browser", "work", "open", "https://example.com"]`. Passed verbatim to
   * the process — never shell-interpreted — so arguments may contain spaces and
   * special characters without any quoting.
   */
  args: string[];

  /** Optional per-command timeout in seconds (5–120, default 45). */
  timeout?: number;

  /**
   * Optional explicit path to the opencli executable (or its JS entry). Escape
   * hatch for the rare case where opencli is installed but its global bin dir is
   * not on the easycode process's PATH: find it with `where opencli` (Windows)
   * or `which opencli` (macOS/Linux) and pass the result here. In the common
   * case this is unnecessary — after a global install the tool re-probes on the
   * next call without a restart.
   */
  binaryPath?: string;
}

/** Robust output structure for OpenCliTool. */
export interface OpenCliResult extends ToolResult {
  status: 'success' | 'failed' | 'auth_required';
  data?: unknown;
  errorKind?: OpenCliErrorKind;
  error?: string;
}

/**
 * OpenCliTool is a thin, agent-native wrapper around the `opencli` CLI, which
 * turns an already-logged-in real Chrome into a deterministic, CDP-driven
 * browser the agent can script (inspect a page, fill forms, click flows,
 * extract data — reusing the user's session, no re-login).
 *
 * Design (deliberately different from the lark-cli wrapper):
 *   - **Thin primitive surface, knowledge in a skill.** This tool only exposes
 *     opencli's browser primitives as a passthrough argv. Per-site know-how
 *     lives in the `opencli-browser` skill (read it before non-trivial flows)
 *     rather than being baked into a giant description.
 *   - **No shell, exact argv.** We spawn with `shell:false` against the resolved
 *     JS entry (or fall back to the binary) and pass `args` as a verbatim argv
 *     array — no hand-rolled quoting, no injection surface.
 *   - **Read passes, writes confirm.** Inspection verbs run unattended; any
 *     page mutation (click/type/fill/select/keys/upload/…) goes through the
 *     approval gate, and "always allow" whitelists that verb for the session.
 *   - **Health preflight.** Before the first browser command we probe the local
 *     daemon and extension so a missing prerequisite returns one clear,
 *     classified error instead of a confusing mid-flow failure.
 *   - **Structured error classification.** daemon-not-running / extension /
 *     not-logged-in / stale-ref / CDP-detach / timeout are surfaced as a
 *     machine-readable `errorKind` with an actionable hint.
 *
 * Sessions persist daemon-side keyed by the `<session>` name in `args` — reuse
 * the same name across calls to keep a tab/state alive; pick a different one to
 * isolate parallel work. The tool itself stays stateless.
 */
export class OpenCliTool extends BaseTool<OpenCliParams, OpenCliResult> {
  static readonly Name: string = 'opencli';

  /** Write verbs the user chose "always allow" for this session. */
  private readonly allowlist: Set<string> = new Set();
  /** Cached binary resolution (probing the global install is not free). */
  private invocation?: OpenCliInvocation;
  /** Whether the daemon/extension preflight has already passed this run. */
  private preflightOk = false;

  constructor(private readonly config: Config) {
    super(
      OpenCliTool.Name,
      'OpenCLI',
      [
        'Drive a real, already-logged-in Chrome as a deterministic CLI via `opencli`: inspect pages, fill forms, click through authenticated flows, and extract data — reusing the user\'s browser session (no re-login, no scraping fragility). Prefers purpose-built site/app adapters (155 websites + 9 apps) and falls back to raw browser primitives only for gaps.',
        '',
        'RULES:',
        '- ALWAYS use this tool for opencli — NEVER run `opencli` through run_shell_command/shell. This tool adds the health preflight, the read/write approval gate, and structured error classification.',
        '- `args` is the EXACT argument vector (no shell, no quoting). Example: args=["browser","work","open","https://example.com"]. Spaces/special chars go in their own element, e.g. args=["browser","work","type","4","hello world"].',
        '',
        'ADAPTERS FIRST — discover before you drive (DO THIS BEFORE OPENING A URL):',
        '- opencli ships 155 website adapters (e.g. 12306, github, zhihu, bilibili, reddit, youtube) and 9 app adapters, each wrapping a real task into ONE high-level command. These are far more reliable than hand-driving the DOM, so NEVER default to `["browser",...,"open","<url>"]` + find/click/type when an adapter might already do the job.',
        '- For ANY request that targets a known site/app, FIRST run `--help` to discover whether a packaged command exists. `--help` queries are read-only: they run with NO confirmation and need NO daemon/extension/Chrome, so they are cheap — always check first:',
        '    1. args=["--help"] — list every available site/app adapter.',
        '    2. args=["<site>","--help"] (e.g. ["github","--help"]) — list that adapter\'s commands.',
        '    3. args=["<site>","<command>","--help"] (e.g. ["github","issues","--help"]) — see a command\'s flags/args.',
        '- If a matching command exists, USE IT: args=["<site>","<command>",...,"--format","json"] (e.g. ["github","issues","--format","json"]).',
        '- Only fall back to `browser` primitives when `--help` shows no command that fits (a true gap, a one-off page, or a site with no adapter).',
        '- Per-site knowledge lives in the `opencli-browser` skill. Read it (via the skills tools) before any non-trivial browser-primitive flow instead of guessing selectors or verbs.',
        '',
        'SESSION MODEL:',
        '- `browser` commands take a `<session>` positional right after `browser`: args=["browser","<session>","<verb>",...]. Reuse the same session name across calls to keep the tab/state alive; use a different name for parallel work. State persists daemon-side.',
        '- bind an existing tab: args=["browser","<session>","bind"]; release: ["browser","<session>","close"] or ["browser","<session>","unbind"].',
        '',
        'CORE RULES (see the skill for the full contract):',
        '- Inspect before acting: run `state` or `find` first; numeric `[N]` refs are per-snapshot — never hard-code one from memory.',
        '- After a navigation/submit, take a fresh `state`; old refs go stale.',
        '- Verify writes that matter: after `type`, run `get value`; check `match_level` (exact|stable|reidentified).',
        '- Branch on the structured `error.code`, not on message text.',
        '',
        'PRIMITIVES:',
        '- Inspect (read): state | find --css <sel> | find --role <r> --name <n> | get title|url|text|value|attributes <target> | get html [--as json] | frames | screenshot | network [--detail <key>] | extract | eval "<js>".',
        '- Interact (write — needs confirmation): click | dblclick | hover | focus | type <t> <text> | fill <t> <text> | select <t> <opt> | check | uncheck | upload <t> <file> | drag <s> <t> | keys <key> | scroll <dir>.',
        '- Navigate (write): open <url> | back | reload. Wait: wait selector|text|download|time. Tabs: tab list|new|select|close.',
        '',
        'SETUP / TROUBLESHOOTING:',
        '- not-installed: opencli itself is missing. Run `npm install -g @jackwener/opencli@latest` (via run_shell_command), then just retry this tool — it re-probes automatically, no easycode restart needed. Only if it still reports not-installed, `where opencli`/`which opencli` and pass the path via `binaryPath`.',
        '- Prerequisites: the opencli daemon, the Browser Bridge Chrome extension, and a logged-in Chrome. If a command fails with daemon-not-running or extension-not-connected, run args=["doctor"] and follow its guidance.',
        '- not-logged-in / auth_required: the user must log in to the site in their Chrome; opencli reuses that session.',
        '- stale-ref / selector errors: re-run `state` and use a fresh ref.',
      ].join('
'),
      Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          args: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description:
              'The complete opencli argument vector, passed verbatim (no shell). E.g. ["browser","work","state"] or ["doctor"]. Put each token — including values with spaces — in its own element.',
          },
          timeout: {
            type: Type.NUMBER,
            description:
              'Optional per-command timeout in seconds (5–120, default 45). Raise it for slow `wait` commands.',
          },
          binaryPath: {
            type: Type.STRING,
            description:
              'Optional explicit path to the opencli executable or its JS entry. Only needed if a command failed with errorKind "not-installed" even though opencli IS installed — find the path via `where opencli` (Windows) / `which opencli` (macOS/Linux) and pass it here. Normally omit it: after `npm install -g`, just retry and the tool re-probes.',
          },
        },
        required: ['args'],
      },
      true, // isOutputMarkdown
      false, // forceMarkdown
      true, // canUpdateOutput — stream live output for longer browser ops
    );
  }

  validateToolParams(params: OpenCliParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      OpenCliTool.Name,
    );
    if (errors) {
      return errors;
    }

    if (!Array.isArray(params.args) || params.args.length === 0) {
      return 'Parameter "args" must be a non-empty array of strings.';
    }
    for (const arg of params.args) {
      if (typeof arg !== 'string') {
        return 'Each element in "args" must be a string.';
      }
    }
    if (params.timeout !== undefined) {
      if (
        typeof params.timeout !== 'number' ||
        !Number.isFinite(params.timeout) ||
        params.timeout < MIN_TIMEOUT_S ||
        params.timeout > MAX_TIMEOUT_S
      ) {
        return `Parameter "timeout" must be a number between ${MIN_TIMEOUT_S} and ${MAX_TIMEOUT_S} seconds.`;
      }
    }
    if (
      params.binaryPath !== undefined &&
      (typeof params.binaryPath !== 'string' || params.binaryPath.trim() === '')
    ) {
      return 'Parameter "binaryPath" must be a non-empty string when provided.';
    }
    return null;
  }

  getDescription(params: OpenCliParams): string {
    const argv = Array.isArray(params.args) ? params.args.join(' ') : '';
    return `Running opencli ${argv}`.trim();
  }

  /**
   * Read passes unattended; any page-mutating command requires confirmation.
   * Mirrors the shell tool's allowlist: choosing "always allow" whitelists the
   * specific verb for the remainder of the session.
   */
  async shouldConfirmExecute(
    params: OpenCliParams,
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (this.validateToolParams(params)) {
      return false; // skip confirmation; execute() will fail validation cleanly
    }
    if (!this.isWriteOperation(params.args)) {
      return false;
    }

    const key = this.confirmationKey(params.args);
    if (this.allowlist.has(key)) {
      return false;
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm OpenCLI write',
      command: `opencli ${params.args.join(' ')}`,
      rootCommand: key,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.allowlist.add(key);
        }
      },
    };
    return confirmationDetails;
  }

  async execute(
    params: OpenCliParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<OpenCliResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return this.failure(validationError, 'launch-error');
    }

    // Resolve how to launch opencli up front. If it is not installed (and no
    // explicit binaryPath / npx opt-in), surface one actionable error instead
    // of limping along. Crucially this is the ONLY place we resolve per call,
    // and a "not found" result is never cached — so once the user runs the
    // suggested `npm install -g`, the very next call re-probes and just works
    // (no restart of easycode needed).
    const resolved = this.resolveInvocation(params);
    if (!resolved.invocation) {
      return this.failure(resolved.message, resolved.kind);
    }
    const invocation = resolved.invocation;

    // Health preflight: for browser-stack commands, verify the daemon and
    // extension once before running, so a missing prerequisite is reported as a
    // single clear error rather than a confusing mid-command failure.
    if (this.shouldPreflight(params.args)) {
      const preflight = await this.runPreflight(invocation, signal);
      if (preflight) {
        return preflight; // short-circuit with the classified setup error
      }
    }

    const timeoutMs = this.resolveTimeoutMs(params.timeout);
    const raw = await this.runStreaming(
      invocation,
      params.args,
      timeoutMs,
      signal,
      updateOutput,
    );
    return this.buildResult(raw);
  }

  // ── Classification helpers ──────────────────────────────────────────────

  /** Top-level command token (e.g. "browser", "doctor", a site name). */
  private topCommand(args: string[]): string {
    return (args[0] || '').toLowerCase();
  }

  /**
   * Whether the argv is a `--help`/`-h` discovery query. opencli's CLI parser
   * intercepts these flags at any position and just prints help, so the command
   * never mutates a page and never touches the daemon/extension. We special-case
   * them so the recommended "run `<site> --help` first" workflow runs unattended
   * (no write confirmation) and without a needless browser-stack preflight. (The
   * bare-word `help` top command is handled separately via READ_TOP/NO_PREFLIGHT_TOP;
   * we only match the unambiguous flags here so a literal "help" typed into a
   * field is not misread as a help query.)
   */
  private isHelpQuery(args: string[]): boolean {
    return args.some((a) => a === '--help' || a === '-h');
  }

  /** Whether the argv represents a page-mutating (write) operation. */
  private isWriteOperation(args: string[]): boolean {
    if (this.isHelpQuery(args)) {
      return false;
    }
    const top = this.topCommand(args);
    if (top === 'browser') {
      // args: ["browser", "<session>", "<verb>", ...]
      const verb = (args[2] || '').toLowerCase();
      return !READ_BROWSER_VERBS.has(verb);
    }
    if (READ_TOP.has(top)) {
      return false;
    }
    if (top === 'daemon') {
      const sub = (args[1] || '').toLowerCase();
      return !(sub === 'status' || sub === '' || sub === 'logs');
    }
    if (top === 'auth') {
      const sub = (args[1] || '').toLowerCase();
      return !(sub === 'whoami' || sub === 'status' || sub === 'list');
    }
    if (top === 'web') {
      const sub = (args[1] || '').toLowerCase();
      return sub !== 'read';
    }
    // Unknown / site-adapter command: fail closed (treat as a write).
    return true;
  }

  /** Stable allowlist key for a write verb (e.g. "browser:click", "facebook"). */
  private confirmationKey(args: string[]): string {
    const top = this.topCommand(args);
    if (top === 'browser') {
      return `browser:${(args[2] || '').toLowerCase()}`;
    }
    if (args[1]) {
      return `${top}:${args[1].toLowerCase()}`;
    }
    return top;
  }

  private resolveTimeoutMs(timeout?: number): number {
    const s =
      typeof timeout === 'number' && Number.isFinite(timeout)
        ? Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, timeout))
        : DEFAULT_TIMEOUT_S;
    return s * 1000;
  }

  // ── Binary resolution ───────────────────────────────────────────────────

  /**
   * Resolve how to launch opencli. Preferred path: run the package's JS entry
   * with the current Node so we can use `shell:false` on every OS and pass an
   * exact argv (no quoting, no `.cmd` shell requirement on Windows). Falls back
   * to the `opencli` binary on PATH — which on Windows is `opencli.cmd` and
   * therefore needs a shell.
   *
   * Resolution order:
   *   1. An explicit `binaryPath` param (escape hatch; never cached).
   *   2. A previously cached *successful* resolution.
   *   3. The global JS entry (`npm root -g`), then the `opencli` binary on PATH.
   *   4. `npx` — only when `OPENCLI_USE_NPX=1` is set (opt-in; per-call npx is
   *      far too slow for this tool's many small commands).
   *
   * When nothing is found we return a `not-installed` result. That negative is
   * deliberately NOT cached: after the user runs `npm install -g`, the next call
   * re-probes and resolves — no restart of easycode required.
   */
  private resolveInvocation(params: OpenCliParams): InvocationResolution {
    const isWin = os.platform() === 'win32';

    // 1. Explicit path wins (and is intentionally not cached — it is cheap to
    //    re-derive and may differ from the auto-detected install).
    const explicit = params.binaryPath?.trim();
    if (explicit) {
      if (!fs.existsSync(explicit)) {
        return {
          invocation: null,
          kind: 'launch-error',
          message: `The provided binaryPath does not exist: ${explicit}`,
        };
      }
      return { invocation: this.invocationForPath(explicit, isWin) };
    }

    // 2. Reuse a successful resolution for the rest of the session.
    if (this.invocation) {
      return { invocation: this.invocation };
    }

    // 3. Global JS entry, then the PATH binary.
    const entry = this.findOpencliEntry();
    if (entry) {
      this.invocation = {
        command: process.execPath,
        baseArgs: [entry],
        shell: false,
      };
      return { invocation: this.invocation };
    }
    const probe = spawnSync(isWin ? 'where' : 'which', ['opencli'], {
      timeout: 3000,
      shell: isWin,
    });
    if (probe.status === 0) {
      this.invocation = { command: 'opencli', baseArgs: [], shell: isWin };
      return { invocation: this.invocation };
    }

    // 4. Opt-in npx fallback (zero-config / CI). Off by default.
    if (process.env.OPENCLI_USE_NPX === '1') {
      this.invocation = {
        command: isWin ? 'npx.cmd' : 'npx',
        baseArgs: [OPENCLI_PACKAGE],
        shell: false,
      };
      return { invocation: this.invocation };
    }

    // Nothing found. Do NOT cache — let a later call re-probe after install.
    return {
      invocation: null,
      kind: 'not-installed',
      message: 'OpenCLI is not installed.',
    };
  }

  /** Build an invocation from an explicit path: node for a JS entry, else direct. */
  private invocationForPath(p: string, isWin: boolean): OpenCliInvocation {
    if (/\.(c|m)?js$/i.test(p)) {
      return { command: process.execPath, baseArgs: [p], shell: false };
    }
    // A binary/shim (e.g. opencli or opencli.cmd). `.cmd` needs a shell on Win.
    return { command: p, baseArgs: [], shell: isWin };
  }

  /** Locate the opencli JS entry of a global install, if present. */
  private findOpencliEntry(): string | null {
    const override = process.env.OPENCLI_ENTRY;
    if (override && fs.existsSync(override)) {
      return override;
    }
    try {
      const probe = spawnSync('npm', ['root', '-g'], {
        timeout: 5000,
        encoding: 'utf8',
        shell: os.platform() === 'win32',
      });
      if (probe.status === 0 && typeof probe.stdout === 'string') {
        const root = probe.stdout.trim();
        if (root) {
          const entry = path.join(
            root,
            '@jackwener',
            'opencli',
            'dist',
            'src',
            'main.js',
          );
          if (fs.existsSync(entry)) {
            return entry;
          }
        }
      }
    } catch {
      // ignore — fall back to the PATH binary
    }
    return null;
  }

  // ── Preflight ───────────────────────────────────────────────────────────

  /** Browser-stack commands need a live daemon + extension; infra commands don't. */
  private shouldPreflight(args: string[]): boolean {
    if (process.env.OPENCLI_SKIP_PREFLIGHT === '1') {
      return false;
    }
    if (this.preflightOk) {
      return false;
    }
    // A `<site> --help` discovery query just prints static help — no browser
    // stack involved — so don't gate it behind the daemon/extension preflight.
    if (this.isHelpQuery(args)) {
      return false;
    }
    return !NO_PREFLIGHT_TOP.has(this.topCommand(args));
  }

  /**
   * Probe `opencli daemon status` once. Returns a classified failure result if
   * the daemon is down or the extension is not connected, or `null` when the
   * stack is ready (and caches that so subsequent calls skip the probe).
   */
  private async runPreflight(
    invocation: OpenCliInvocation,
    signal: AbortSignal,
  ): Promise<OpenCliResult | null> {
    const raw = await this.runStreaming(
      invocation,
      ['daemon', 'status'],
      PREFLIGHT_TIMEOUT_MS,
      signal,
    );

    // If the probe itself could not run, let the real command surface the
    // error rather than blocking on a flaky preflight.
    if (raw.launchError || raw.aborted) {
      return null;
    }

    const text = `${raw.stdout}\n${raw.stderr}`;
    const lower = text.toLowerCase();

    if (lower.includes('daemon: not running') || lower.includes('not running')) {
      if (process.env.OPENCLI_SKIP_AUTOSTART === '1') {
        return this.failure(
          'OpenCLI daemon is not running.',
          'daemon-not-running',
        );
      }
      // Zero-friction: attempt to automatically launch the daemon in the background!
      const { command, baseArgs, shell } = invocation;
      const startArgv = [...baseArgs, 'daemon', 'restart'];
      try {
        const daemonProcess = spawn(command, startArgv, {
          shell,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env },
        });
        if (daemonProcess && typeof daemonProcess.unref === 'function') {
          daemonProcess.unref();
        }

        // Give it 3 seconds to spin up and bind the port (or 1ms in tests to prevent hanging)
        const delay = process.env.NODE_ENV === 'test' ? 1 : 3000;
        await new Promise((r) => setTimeout(r, delay));

        // Re-probe status
        const retryRaw = await this.runStreaming(
          invocation,
          ['daemon', 'status'],
          PREFLIGHT_TIMEOUT_MS,
          signal,
        );
        const retryText = `${retryRaw.stdout}\n${retryRaw.stderr}`.toLowerCase();
        if (!retryText.includes('daemon: not running') && !retryText.includes('not running')) {
          if (
            retryText.includes('extension: disconnected') ||
            retryText.includes('none selected') ||
            retryText.includes('not connected')
          ) {
            return this.failure(
              'OpenCLI daemon was started automatically, but the Browser Bridge extension is not connected.',
              'extension-not-connected',
            );
          }
          this.preflightOk = true;
          return null; // Success!
        }
      } catch {
        // Fall back to reporting the original daemon error
      }

      return this.failure(
        'OpenCLI daemon is not running and auto-start failed.',
        'daemon-not-running',
      );
    }
    if (
      lower.includes('extension: disconnected') ||
      lower.includes('none selected') ||
      lower.includes('not connected')
    ) {
      return this.failure(
        'OpenCLI is running but the Browser Bridge extension is not connected.',
        'extension-not-connected',
      );
    }

    this.preflightOk = true;
    return null;
  }

  // ── Process execution ───────────────────────────────────────────────────

  /**
   * Spawn opencli with an exact argv (no shell on the preferred path) and stream
   * its output. Resolves with the raw outcome; callers classify it.
   */
  private runStreaming(
    invocation: OpenCliInvocation,
    args: string[],
    timeoutMs: number,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<RawRunResult> {
    const { command, baseArgs, shell } = invocation;
    const argv = [...baseArgs, ...args];

    return new Promise<RawRunResult>((resolve) => {
      let child;
      try {
        child = spawn(command, argv, {
          shell,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } catch (err) {
        resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: false,
          launchError: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let combined = '';
      let lastUpdateTime = 0;
      let settled = false;

      const flush = (force = false) => {
        if (!updateOutput) return;
        const now = Date.now();
        if (!force && now - lastUpdateTime < OUTPUT_UPDATE_INTERVAL_MS) return;
        lastUpdateTime = now;
        updateOutput(combined);
      };

      const onData = (buf: Buffer, isErr: boolean) => {
        const str = buf.toString('utf8');
        if (isErr) stderr += str;
        else stdout += str;
        combined += str;
        flush();
      };

      child.stdout?.on('data', (buf: Buffer) => onData(buf, false));
      child.stderr?.on('data', (buf: Buffer) => onData(buf, true));

      const killChild = () => {
        if (child.killed) return;
        try {
          if (os.platform() === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          // best effort
        }
      };

      let timedOut = false;
      let aborted = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killChild();
      }, timeoutMs);

      const onAbort = () => {
        if (settled) return;
        aborted = true;
        killChild();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanup = () => {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
      };

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          code: null,
          stdout,
          stderr,
          timedOut,
          aborted,
          launchError: err.message || 'Failed to launch opencli',
        });
      });

      child.on('exit', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        flush(true);
        resolve({ code, stdout, stderr, timedOut, aborted });
      });
    });
  }

  // ── Result construction ─────────────────────────────────────────────────

  private buildResult(raw: RawRunResult): OpenCliResult {
    const { code, stdout, stderr, timedOut, aborted, launchError } = raw;
    const output = stdout.trim();

    if (launchError) {
      return this.failure(
        `Failed to launch opencli: ${launchError}`,
        'launch-error',
      );
    }
    if (aborted) {
      return this.failure('OpenCLI execution was cancelled.', 'aborted');
    }
    if (timedOut) {
      return this.failure(
        `OpenCLI command timed out.`,
        'timeout',
      );
    }

    if (code === 0) {
      let data: unknown;
      try {
        data = JSON.parse(output || '{}');
      } catch {
        data = { rawOutput: output };
      }
      return {
        status: 'success',
        data,
        llmContent: JSON.stringify({ status: 'success', data }),
        returnDisplay: output || 'opencli executed successfully.',
        summary: 'Success',
      };
    }

    // Non-zero exit: classify into an actionable error kind.
    const kind = this.classifyError(stdout, stderr, code);
    const baseMessage =
      this.extractMessage(stdout, stderr) ||
      `opencli exited with code ${code}`;
    const hint = this.hintFor(kind);
    const message = hint ? `${baseMessage}\n\n${hint}` : baseMessage;
    const status = kind === 'not-logged-in' ? 'auth_required' : 'failed';

    const icon = status === 'auth_required' ? '🔑' : '❌';
    return {
      status,
      errorKind: kind,
      error: message,
      data: { status, errorKind: kind, error: message, exitCode: code },
      llmContent: JSON.stringify({ status, errorKind: kind, error: message }),
      returnDisplay: `${icon} ${message}`,
      summary: status === 'auth_required' ? 'Auth Required' : 'Failed',
    };
  }

  /** Build a structured failure result with a classified kind + hint. */
  private failure(message: string, kind: OpenCliErrorKind): OpenCliResult {
    const status = kind === 'not-logged-in' ? 'auth_required' : 'failed';
    const hint = this.hintFor(kind);
    const full = hint ? `${message}\n\n${hint}` : message;
    const icon = status === 'auth_required' ? '🔑' : '❌';
    return {
      status,
      errorKind: kind,
      error: full,
      data: { status, errorKind: kind, error: full },
      llmContent: JSON.stringify({ status, errorKind: kind, error: full }),
      returnDisplay: `${icon} ${full}`,
      summary: status === 'auth_required' ? 'Auth Required' : 'Failed',
    };
  }

  /**
   * Classify an opencli failure from its output + exit code. Order matters:
   * structured stdout codes (stale_ref/selector) are checked before the
   * exit-code buckets, and transient CDP/extension hiccups before generic
   * connect failures.
   */
  private classifyError(
    stdout: string,
    stderr: string,
    code: number | null,
  ): OpenCliErrorKind {
    const haystack = `${stdout}\n${stderr}`;
    const lower = haystack.toLowerCase();
    const structuredCode = this.extractErrorCode(stdout, stderr);

    // 1. Selector-first target errors (JSON envelope on stdout).
    if (structuredCode === 'stale_ref' || lower.includes('stale_ref')) {
      return 'stale-ref';
    }
    if (
      structuredCode === 'not_found' ||
      structuredCode === 'invalid_selector' ||
      structuredCode === 'selector_not_found' ||
      structuredCode === 'selector_ambiguous' ||
      structuredCode === 'selector_nth_out_of_range' ||
      structuredCode === 'option_not_found' ||
      structuredCode === 'not_a_select' ||
      structuredCode === 'SELECTOR'
    ) {
      return 'selector';
    }

    // 2. Transient CDP/extension hiccups (retryable) — before generic connect.
    if (
      lower.includes('detached while handling command') ||
      lower.includes('inspected target navigated') ||
      lower.includes('debugger is not attached') ||
      lower.includes('extension disconnected') ||
      lower.includes('attach failed') ||
      (lower.includes('-32000') && /target|context/i.test(haystack))
    ) {
      return 'cdp-detached';
    }

    // 3. Daemon / extension connectivity (BROWSER_CONNECT / exit 69).
    if (structuredCode === 'BROWSER_CONNECT' || code === 69) {
      if (
        lower.includes('extension') ||
        lower.includes('browser bridge') ||
        lower.includes('none selected') ||
        lower.includes('not connected')
      ) {
        return 'extension-not-connected';
      }
      return 'daemon-not-running';
    }
    if (lower.includes('cannot connect to opencli daemon') || lower.includes('daemon: not running')) {
      return 'daemon-not-running';
    }
    if (lower.includes('extension is not connected') || lower.includes('browser bridge')) {
      return 'extension-not-connected';
    }

    // 4. Auth / login wall (exit 77).
    if (
      structuredCode === 'AUTH_REQUIRED' ||
      structuredCode === 'LOGIN_WALL' ||
      code === 77 ||
      lower.includes('not logged in') ||
      lower.includes('please open chrome') ||
      lower.includes('log in to')
    ) {
      return 'not-logged-in';
    }

    // 5. Timeout (exit 75) and empty result (exit 66).
    if (structuredCode === 'TIMEOUT' || code === 75 || lower.includes('timed out after')) {
      return 'timeout';
    }
    if (structuredCode === 'EMPTY_RESULT' || code === 66) {
      return 'empty';
    }

    return 'unknown';
  }

  /** Pull an `error.code` from a JSON stdout envelope or a YAML stderr envelope. */
  private extractErrorCode(stdout: string, stderr: string): string | null {
    // Browser commands emit a JSON `{ error: { code } }` envelope on stdout.
    const jsonStart = stdout.indexOf('{');
    if (jsonStart !== -1) {
      try {
        const parsed = JSON.parse(stdout.slice(jsonStart));
        const c = parsed?.error?.code;
        if (typeof c === 'string') return c;
      } catch {
        // not JSON — fall through
      }
    }
    // Top-level CliErrors render a YAML envelope on stderr with a `code:` line.
    const m = stderr.match(/^\s*code:\s*([A-Za-z0-9_]+)\s*$/m);
    return m ? m[1] : null;
  }

  /** Best human-readable message from a JSON/YAML envelope or raw stderr. */
  private extractMessage(stdout: string, stderr: string): string {
    const jsonStart = stdout.indexOf('{');
    if (jsonStart !== -1) {
      try {
        const parsed = JSON.parse(stdout.slice(jsonStart));
        const msg = parsed?.error?.message;
        if (typeof msg === 'string' && msg.trim()) {
          const hint = parsed?.error?.hint;
          return hint ? `${msg}\nHint: ${hint}` : msg;
        }
      } catch {
        // fall through
      }
    }
    const yamlMsg = stderr.match(/^\s*message:\s*(.+)$/m);
    if (yamlMsg) {
      return yamlMsg[1].trim();
    }
    return stderr.trim() || stdout.trim();
  }

  /** Actionable, kind-specific guidance appended to the error message. */
  private hintFor(kind: OpenCliErrorKind): string {
    switch (kind) {
      case 'daemon-not-running':
        return '👉 The opencli daemon is not running. Ask me to start it, or run opencli ["doctor"] to diagnose.';
      case 'extension-not-connected':
        return '👉 The Browser Bridge Chrome extension is not connected. Make sure Chrome is open and the official extension is installed/enabled from here: https://chromewebstore.google.com/detail/opencli-browser-bridge/ildkmabpimmkaediidaifkhjpohdnifk, then try again. Run opencli ["doctor"] for details.';
      case 'not-logged-in':
        return '🔑 The target site is not logged in. Ask the user to log in to the site in their Chrome — opencli reuses that session — then retry.';
      case 'stale-ref':
        return '👉 The numeric ref is stale (the page changed). Re-run ["browser","<session>","state"] and use a fresh [N] ref.';
      case 'selector':
        return '👉 The target could not be resolved. Re-run `state`/`find` to get a valid ref or selector; check the error envelope\'s candidates/available list.';
      case 'cdp-detached':
        return '👉 Transient CDP/extension hiccup (the tab navigated or the debugger detached). Re-run `state` and retry the command.';
      case 'timeout':
        return '👉 Timed out. For `wait` commands raise the `timeout` param; otherwise re-run `state` and retry.';
      case 'empty':
        return '👉 No data returned. The page structure may have changed, or you may need to log in / wait for content.';
      case 'not-installed':
        return [
          '👉 OpenCLI is not installed. Install it globally, then simply re-run this command — the tool re-probes automatically, so NO restart of easycode is needed:',
          `    npm install -g ${OPENCLI_PACKAGE}`,
          '   (on macOS/Linux this may require sudo). If it still reports "not-installed" after a successful install, the global bin dir is likely not on this process\'s PATH: run `where opencli` (Windows) or `which opencli` (macOS/Linux) and pass that path via the tool\'s `binaryPath` parameter.',
        ].join('
');
      default:
        return '';
    }
  }
}
