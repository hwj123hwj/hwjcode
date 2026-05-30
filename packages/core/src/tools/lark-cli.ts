/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

/**
 * Throttle interval for pushing live output to the UI.
 */
const OUTPUT_UPDATE_INTERVAL_MS = 500;

/**
 * Fallback watchdog timeout. The device-flow authorization (`auth login` /
 * `config init`) intentionally blocks for up to ~10 minutes while the user
 * authorizes in their browser, so we must NOT impose the 5-minute shell
 * timeout here. We allow a generous 15-minute ceiling purely to guard against
 * a permanently hung child process — normal commands return in well under a
 * second and never reach it.
 */
const FALLBACK_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Matches the interactive authorization links emitted by lark-cli. Covers both
 * the modern device-flow page (`/page/cli?user_code=...`) and the legacy
 * `/open-apis/authen` endpoint, across the Feishu (open.feishu.cn) and Lark
 * (open.larksuite.com) brands.
 */
const AUTH_URL_REGEX =
  /https?:\/\/[^\s'"]*?(?:page\/cli\?user_code=|open-apis\/authen)[^\s'"]*/;

/**
 * Commands that themselves perform authorization. We must never trigger the
 * automatic device-flow takeover for these, or we would recurse forever.
 */
function isAuthCommand(command: string): boolean {
  const c = command.trim().toLowerCase();
  return (
    c.startsWith('config init') ||
    c.startsWith('auth login') ||
    c.startsWith('auth logout')
  );
}

/**
 * Raw outcome of a single child-process run, before it is translated into a
 * user-facing LarkCliResult. Kept internal so execute() can inspect failures
 * and decide whether to auto-start the device-flow login.
 */
interface RawRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  authUrl?: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process failed to even launch (spawn error). */
  launchError?: string;
}

/**
 * Parameters for the LarkCliTool.
 */
export interface LarkCliParams {
  /**
   * The lark-cli command to run. Supports both shortcut style (with +) and normal API commands.
   */
  command: string;

  /**
   * List of arguments to append to the command.
   */
  args?: string[];

  /**
   * Switch authentication identity.
   */
  as?: 'user' | 'bot';
}

/**
 * Robust output structure for LarkCliTool, extending base ToolResult.
 */
export interface LarkCliResult extends ToolResult {
  status: 'success' | 'failed' | 'auth_required';
  data?: any;
  authUrl?: string;
  error?: string;
}

/**
 * LarkCliTool is a universal AI Agent-native wrapper around the official lark-cli.
 *
 * It runs the CLI as a long-lived child process and streams its output to the
 * UI in real time (like watching `ping` scroll). This is critical for the
 * device-flow authorization: the wrapper captures the verification URL the
 * instant lark-cli prints it and surfaces it to the user, while keeping the
 * child process alive in the background so it can keep polling. When the user
 * finishes authorizing, lark-cli exits 0 and the agent learns the flow
 * completed — all within a single tool call, with no manual shell juggling.
 */
export class LarkCliTool extends BaseTool<LarkCliParams, LarkCliResult> {
  static readonly Name: string = 'lark_cli';

  constructor(private readonly config: Config) {
    super(
      LarkCliTool.Name,
      'LarkCli',
      [
        'Unified wrapper for the official lark-cli tool. Provides access to 18+ business domains in Lark (Feishu) for both automation and AI agent-driven workflows.',
        '',
        'RULES:',
        '- ALWAYS use this tool for every Lark/Feishu operation — NEVER run lark-cli via run_shell_command/shell.',
        '- Authorization is fully automatic: if the CLI is not configured/authorized yet, this tool launches the browser device-flow login itself and streams the verification URL to the user in real time within the same call. Do NOT manually run "lark-cli config init" or "auth login" in a shell.',
        '- Do NOT guess subcommands or flags. If unsure what a command supports, run it with "--help" first (e.g. command="calendar --help"). Error responses include hints with available options — follow them instead of guessing.',
        '',
        'COMMON COMMAND CHEATSHEET (use these patterns to avoid trial-and-error):',
        '',
        '## Calendar',
        '- Today\'s agenda: command="calendar +agenda"',
        '- Agenda by date range: command="calendar +agenda" args=["--start", "2025-01-01", "--end", "2025-01-07"]',
        '- Create event: command="calendar +create" args=["--summary", "Meeting", "--start", "2025-01-01T10:00:00+08:00", "--end", "2025-01-01T11:00:00+08:00"]',
        '- Update event: command="calendar +update" args=["--event-id", "<id>", "--summary", "New Title"]',
        '- Free/busy query: command="calendar +freebusy" args=["--start", "2025-01-01", "--end", "2025-01-01"]',
        '- Find meeting rooms: command="calendar +room-find" args=["--slot", "2025-01-01T10:00:00+08:00~2025-01-01T11:00:00+08:00"]',
        '- RSVP to event: command="calendar +rsvp" args=["--event-id", "<id>", "--rsvp-status", "accept"]',
        '- Smart time suggestion: command="calendar +suggestion" args=["--start", "2025-01-01", "--end", "2025-01-07"]',
        '',
        '## Docs (Documents)',
        '- Create doc from file (RECOMMENDED for content >500 chars): command="docs +create" args=["--api-version", "v2", "--title", "Title", "--content", "@<relative-path>", "--doc-format", "markdown"]',
        '  CRITICAL: Use --content with @file (NOT inline text for long content — inline silently drops content; NOT --markdown — that flag does not exist for create). The @ prefix reads a local file (must be relative path like temp/myfile.md). For documents longer than ~500 characters, ALWAYS write content to a temp file first and use @<relative-path>. Also always include --title.',
        '- Create doc from short inline text: command="docs +create" args=["--api-version", "v2", "--title", "Title", "--content", "<short-text>", "--doc-format", "markdown"]',
        '- Fetch doc content: command="docs +fetch" args=["--api-version", "v2", "--doc", "<doc_url_or_token>"]',
        '  NOTE: The flag is --doc (NOT --document-id). Accepts document URL or plain token.',
        '- Update doc content: command="docs +update" args=["--api-version", "v2", "--doc", "<doc_url_or_token>", "--markdown", "@<relative-path>", "--mode", "overwrite"]',
        '  NOTE: Update uses --markdown (NOT --content). Mode: overwrite (default), append, replace_all. For long content, use @file here too.',
        '- Search docs: command="docs +search" args=["--query", "<keyword>"]',
        '- Upload media to doc: command="docs +media-upload" args=["--file", "<relative-path>", "--document-id", "<id>"]',
        '',
        '## Sheets (Spreadsheets)',
        '- Create spreadsheet: command="sheets +create" args=["--title", "My Sheet"]',
        '- Read cells: command="sheets +read" args=["--spreadsheet-token", "<token>", "--range", "A1:D10"]',
        '- Write cells: command="sheets +write" args=["--spreadsheet-token", "<token>", "--range", "A1", "--value", "hello"]',
        '- Append rows: command="sheets +append" args=["--spreadsheet-token", "<token>", "--range", "A1:D1", "--values", "[[1,2,3,4]]"]',
        '- Find in sheet: command="sheets +find" args=["--spreadsheet-token", "<token>", "--find", "keyword"]',
        '- Export sheet: command="sheets +export" args=["--spreadsheet-token", "<token>", "--file", "output.xlsx"]',
        '',
        '## IM (Messaging)',
        '- Send message: command="im +messages-send" args=["--receive-id-type", "chat_id", "--receive-id", "<id>", "--msg-type", "text", "--content", "{\\"text\\":\\"hello\\"}"]',
        '- List chats: command="im +chat-list"',
        '- Search chats: command="im +chat-search" args=["--query", "<keyword>"]',
        '- List messages in chat: command="im +chat-messages-list" args=["--chat-id", "<id>"]',
        '- Reply to message: command="im +messages-reply" args=["--message-id", "<id>", "--msg-type", "text", "--content", "{\\"text\\":\\"reply\\"}"]',
        '- Create group chat: command="im +chat-create" args=["--name", "Group Name"]',
        '- Search messages: command="im +messages-search" args=["--query", "<keyword>"]',
        '- Pin (flag) a message: command="im +flag-create" args=["--message-id", "<id>"]',
        '- Download message resource: command="im +messages-resources-download" args=["--message-id", "<id>", "--file-key", "<key>", "--file", "output.png"]',
        '',
        '## Drive (Cloud Drive)',
        '- Upload file: command="drive +upload" args=["--file", "<relative-path>"]',
        '- Download file: command="drive +download" args=["--file-token", "<token>", "--file", "output.bin"]',
        '- Create folder: command="drive +create-folder" args=["--name", "New Folder"]',
        '- Search files: command="drive +search" args=["--query", "<keyword>"]',
        '- Export document: command="drive +export" args=["--file-token", "<token>", "--type", "pdf"]',
        '',
        '## Tasks',
        '- My tasks: command="task +get-my-tasks"',
        '- Create task: command="task +create" args=["--summary", "Task title"]',
        '- Complete task: command="task +complete" args=["--task-id", "<id>"]',
        '- Search tasks: command="task +search" args=["--query", "<keyword>"]',
        '- Create tasklist: command="task +tasklist-create" args=["--name", "My List"]',
        '',
        '## Mail',
        '- List emails (triage): command="mail +triage" args=["--max", "20", "--format", "json"]',
        '- Filter emails by folder: command="mail +triage" args=["--filter", "{\\"folder\\":\\"INBOX\\"}", "--format", "json"]',
        '- Search emails by keyword: command="mail +triage" args=["--query", "keyword", "--format", "json"]',
        '- Read single email: command="mail +message" args=["--message-id", "<id>"]',
        '- Read multiple emails: command="mail +messages" args=["--message-ids", "id1,id2,id3"]',
        '- Send email: command="mail +send" args=["--to", "user@example.com", "--subject", "Hello", "--body", "Content", "--confirm-send"]',
        '- Reply to email: command="mail +reply" args=["--message-id", "<id>", "--body", "Reply content", "--confirm-send"]',
        '- Create draft: command="mail +draft-create" args=["--to", "user@example.com", "--subject", "Draft"]',
        '- View email thread: command="mail +thread" args=["--thread-id", "<id>"]',
        '',
        '## Wiki (Knowledge Base)',
        '- List spaces: command="wiki +space-list"',
        '- List nodes in space: command="wiki +node-list" args=["--space-id", "<id>"]',
        '- Create wiki node: command="wiki +node-create" args=["--space-id", "<id>", "--title", "New Page"]',
        '- Get node info: command="wiki +node-get" args=["--node-token", "<token>"]',
        '',
        '## VC (Video Conference)',
        '- Search meetings: command="vc +search" args=["--start", "2025-01-01", "--end", "2025-01-07"]',
        '- Get meeting recording: command="vc +recording" args=["--meeting-id", "<id>"]',
        '- Get meeting notes: command="vc +notes" args=["--meeting-id", "<id>"]',
        '',
        '## Minutes (Meeting Minutes)',
        '- Search minutes: command="minutes +search" args=["--query", "<keyword>"]',
        '- Download minutes: command="minutes +download" args=["--minutes-id", "<id>"]',
        '',
        '## OKR',
        '- List OKR cycles: command="okr +cycle-list"',
        '- Get cycle detail: command="okr +cycle-detail" args=["--cycle-id", "<id>"]',
        '- Create progress: command="okr +progress-create" args=["--objective-id", "<id>", "--content", "Update"]',
        '',
        '## Contact',
        '- Search user: command="contact +search-user" args=["--query", "<name>"]',
        '- Get user info: command="contact +get-user" args=["--user-id", "<id>"]',
        '',
        '## Slides (Presentations)',
        '- Create slides: command="slides +create" args=["--title", "My Deck"]',
        '',
        '## Approval',
        '- Use API-style: command="approval" (then run --help for subcommands)',
        '',
        'HELP: Run command="<domain> --help" (e.g. "docs --help", "im --help") for full flag details of any domain.',
      ].join('\n'),
      Icon.Hammer,
      {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description:
              'The lark-cli subcommand or shortcut (e.g., "calendar +agenda", "im.messages.create").',
          },
          args: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
            description: 'Optional arguments/flags to append to the command.',
          },
          as: {
            type: Type.STRING,
            enum: ['user', 'bot'],
            description: 'Optional identity under which the command will be run.',
          },
        },
        required: ['command'],
      },
      true, // isOutputMarkdown
      true, // forceMarkdown — render output in full (do not height-truncate), so the device-flow authorization QR code stays scannable in the terminal instead of being folded into "... omitted N lines ..."
      true, // canUpdateOutput — stream live output (URL capture, auth waiting)
    );
  }

  /**
   * Validates parameters using standard SchemaValidator and custom business rules.
   */
  validateToolParams(params: LarkCliParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      LarkCliTool.Name,
    );
    if (errors) {
      return errors;
    }

    if (!params.command || typeof params.command !== 'string' || params.command.trim() === '') {
      return 'Parameter "command" must be a non-empty string.';
    }

    if (params.args !== undefined) {
      if (!Array.isArray(params.args)) {
        return 'Parameter "args" must be an array of strings.';
      }
      for (const arg of params.args) {
        if (typeof arg !== 'string') {
          return 'Each argument in "args" array must be a string.';
        }
      }
    }

    if (params.as !== undefined) {
      if (params.as !== 'user' && params.as !== 'bot') {
        return 'Parameter "as" must be either "user" or "bot".';
      }
    }

    return null;
  }

  getDescription(params: LarkCliParams): string {
    const argsStr = params.args ? ` with args [${params.args.join(', ')}]` : '';
    const identityStr = params.as ? ` as ${params.as}` : '';
    return `Running lark-cli command: "${params.command}"${argsStr}${identityStr}`;
  }

  /**
   * Detects whether lark-cli is installed globally on the user's system,
   * otherwise falls back to a zero-installation npx on-demand execution.
   */
  private detectBinary(): string {
    try {
      // Probing local environment for globally-installed binary. Use a
      // synchronous probe with a short timeout so it never blocks the flow.
      const probe = spawnSync('lark-cli', ['--version'], {
        timeout: 5000,
        shell: true,
      });
      if (probe.status === 0) {
        return 'lark-cli';
      }
    } catch {
      // ignore and fall through to npx
    }
    // Graceful fallback to avoid sudo/permission blocks
    return 'npx @larksuite/cli@latest';
  }

  /**
   * Escapes arguments to secure the command execution against shell command injections.
   */
  private sanitizeArg(arg: string): string {
    return `"${arg.replace(/(["$`\\])/g, '\\$1')}"`;
  }

  /**
   * Builds the full command string passed to the shell.
   */
  private buildCommand(params: LarkCliParams, binary: string): string {
    let cmdString = `${binary} ${params.command}`;

    if (params.args && params.args.length > 0) {
      const sanitized = params.args.map((arg) => this.sanitizeArg(arg));
      cmdString += ` ${sanitized.join(' ')}`;
    }

    // NOTE: --format is a local flag only supported by api/service/shortcut
    // subcommands. Many commands (config init, auth login, --help, etc.) reject
    // it with "unknown flag: --format". Moreover, api/service subcommands
    // already default to JSON output, so adding it is both unnecessary and
    // harmful. Do NOT append --format here.

    if (params.as) {
      cmdString += ` --as ${params.as}`;
    }

    return cmdString;
  }

  async execute(
    params: LarkCliParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<LarkCliResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        status: 'failed',
        error: validationError,
        llmContent: JSON.stringify({ status: 'failed', error: validationError }),
        returnDisplay: `Parameter validation failed: ${validationError}`,
      };
    }

    const binary = this.detectBinary();
    const cmdString = this.buildCommand(params, binary);

    // Run the requested command.
    const raw = await this.runStreaming(cmdString, signal, updateOutput);

    // Automatic device-flow takeover: if a business command fails purely
    // because the CLI is not configured/authorized yet, transparently start
    // the appropriate auth flow in the SAME tool call instead of bubbling up
    // lark-cli's hints (which would tempt the agent to fall back to a raw
    // shell command, hiding the URL from the user). We skip this for auth
    // commands themselves to avoid infinite recursion.
    if (
      !isAuthCommand(params.command) &&
      this.needsAuthorization(raw)
    ) {
      const failureType = this.classifyAuthFailure(raw);
      let authCmd: string;

      if (failureType === 'login') {
        // User login required: extract the auth login command from the hint
        // or infer domain from the original command.
        authCmd = this.extractAuthLoginCommand(raw, params.command, binary);

        // Apply project-level Feishu/Lark authorization scope minimization rules
        let feishuSettings: { recommend?: boolean; excludeScopes?: string[] } | undefined;
        if (typeof this.config.getProjectSettingsManager === 'function') {
          try {
            const projectSettings = this.config.getProjectSettingsManager().load();
            feishuSettings = projectSettings?.feishu;
          } catch {
            // ignore
          }
        }

        // Always exclude highly sensitive scopes like "im:message.send_as_user"
        // by default to comply with strict enterprise security policies.
        const defaultExcludes = ['im:message.send_as_user'];
        const configuredExcludes = feishuSettings?.excludeScopes || [];
        const uniqueExcludes = Array.from(new Set([...defaultExcludes, ...configuredExcludes]));

        if (feishuSettings?.recommend && !authCmd.includes('--recommend')) {
          authCmd += ' --recommend';
        }

        if (uniqueExcludes.length > 0 && !authCmd.includes('--exclude')) {
          authCmd += ` --exclude "${uniqueExcludes.join(',')}"`;
        }

        if (updateOutput) {
          updateOutput(
            '🔑 Lark CLI requires user login. Starting browser authorization...\n',
          );
        }
      } else {
        // App not configured: use config init --new.
        authCmd = `${binary} config init --new`;
        if (updateOutput) {
          updateOutput(
            '⚙️  Lark CLI is not configured yet. Starting app setup...\n',
          );
        }
      }

      const authRaw = await this.runStreaming(authCmd, signal, updateOutput);
      return this.buildResult(authRaw);
    }

    return this.buildResult(raw);
  }

  /**
   * Detects authorization-related failures that warrant an automatic device-flow
   * takeover. Covers two distinct scenarios:
   *
   * 1. "not configured" — the CLI has no app bound yet. Needs `config init --new`.
   * 2. "user_login_required" / "need_user_authorization" — the CLI has an app
   *    but no user is logged in. Needs `auth login --domain <X>` or `--scope <Y>`.
   */
  private needsAuthorization(raw: RawRunResult): boolean {
    if (raw.code === 0 || raw.timedOut || raw.aborted) return false;
    const haystack = `${raw.stdout}\n${raw.stderr}`.toLowerCase();

    // If the app is pending approval by the enterprise admin, automatic takeover
    // will never succeed and will only loop. We must not trigger takeover here.
    if (haystack.includes('pending approval')) {
      return false;
    }

    return (
      haystack.includes('not configured') ||
      haystack.includes('"type": "config"') ||
      haystack.includes('"type":"config"') ||
      /lark-cli\s+config\s+init/.test(haystack) ||
      haystack.includes('user_login_required') ||
      haystack.includes('need_user_authorization') ||
      haystack.includes('missing_scope')
    );
  }

  /**
   * Classifies the authorization failure to determine the correct takeover
   * command. Returns one of:
   *   - 'config'  → app not bound, needs `config init --new`
   *   - 'login'   → user not logged in, needs `auth login`
   */
  private classifyAuthFailure(raw: RawRunResult): 'config' | 'login' {
    const haystack = `${raw.stdout}\n${raw.stderr}`.toLowerCase();
    if (
      haystack.includes('user_login_required') ||
      haystack.includes('need_user_authorization') ||
      haystack.includes('missing_scope')
    ) {
      return 'login';
    }
    return 'config';
  }

  /**
   * Extracts the `auth login` command from lark-cli's error hint. lark-cli
   * enriches its errors with lines like:
   *   "restore user login: `lark-cli auth login --domain calendar`"
   *   "current command requires scope(s): calendar:calendar.event:read"
   *
   * Priority:
   *   1. Exact auth login command from hint (most reliable).
   *   2. Scope from "requires scope(s):" hint → `auth login --scope <scope>`.
   *   3. Domain fallback from the command's first segment → `auth login --domain <seg>`.
   */
  private extractAuthLoginCommand(
    raw: RawRunResult,
    originalCommand: string,
    binary: string,
  ): string {
    const haystack = `${raw.stdout}\n${raw.stderr}`;

    // 1. Look for an explicit "lark-cli auth login --domain/--scope" in the hint.
    //    lark-cli wraps the command in backticks for display, so we must
    //    exclude trailing backticks from the captured value (e.g.
    //    "`lark-cli auth login --domain calendar`" — the closing backtick is
    //    NOT part of the domain).
    //
    //    The --scope value may be quoted and contain spaces:
    //    `lark-cli auth login --scope "scope1 scope2 scope3"`
    //    So we match both unquoted (--scope foo) and quoted (--scope "foo bar")
    //    forms, stopping at a closing backtick or end-of-string.
    //
    //    CRITICAL PRO-TIP: On Windows/win32 systems (and for general stability),
    //    requesting raw scopes with spaces/quotes can get mangled by shell argument
    //    escaping, or fail because the open platform rejects specific scope granularities.
    //    Instead, we dynamically map any extracted "--scope" list into a safe,
    //    quote-free, comma-separated "--domain" list (e.g. "--domain mail").
    const authCmdMatch = haystack.match(
      /lark-cli\s+auth\s+login\s+(--domain\s+[^\s`]+|--scope\s+(?:"[^"]*"|[^\s`]+(?:\s+[^\s`]+)*))/,
    );
    if (authCmdMatch) {
      const matchStr = authCmdMatch[1]; // e.g., --domain calendar or --scope "mail:..."
      if (matchStr.startsWith('--scope')) {
        // Extract raw scope string inside quotes or unquoted
        const scopeContentMatch = matchStr.match(/--scope\s+"([^"]*)"/) || matchStr.match(/--scope\s+([^\s`]+(?:\s+[^\s`]+)*)/);
        if (scopeContentMatch) {
          // Strip literal backslashes and quotes (e.g. from escaped \" in JSON errors)
          const rawScopes = scopeContentMatch[1].replace(/[\\'"]+/g, '');
          // Split scopes by space or comma
          const scopes = rawScopes.split(/[\s,]+/).filter(Boolean);
          // Extract unique domain prefixes (before the first colon, e.g. "mail" from "mail:user_mailbox.message")
          const domains = Array.from(
            new Set(
              scopes.map((s) => s.split(':')[0]).filter((d) => d && d.length > 0)
            )
          );
          if (domains.length > 0) {
            // Map the scopes to robust, quote-free --domain parameters!
            return `${binary} auth login --domain ${domains.join(',')}`;
          }
        }
      }

      // If it is --domain, strip the "lark-cli" prefix and re-attach our binary.
      const flags = authCmdMatch[0].replace(/^lark-cli\s+auth\s+login\s+/, '');
      return `${binary} auth login ${flags}`;
    }

    // 2. Look for "current command requires scope(s): X, Y"
    const scopeMatch = haystack.match(
      /current command requires scope\(s\):\s*(.+)/i,
    );
    if (scopeMatch) {
      // Use the first scope listed; strip trailing punctuation/backticks.
      const scope = scopeMatch[1].split(',')[0].trim().replace(/[`'"]+$/, '');
      const domain = scope.split(':')[0];
      if (domain) {
        return `${binary} auth login --domain ${domain}`;
      }
      return `${binary} auth login --scope ${scope}`;
    }

    // 3. Fallback: infer domain from the command's first segment.
    //    e.g. "calendar +agenda" → domain="calendar"
    const domain = originalCommand.trim().split(/\s+/)[0];
    if (domain) {
      return `${binary} auth login --domain ${domain}`;
    }

    // Last resort: plain auth login (user will pick domain interactively).
    return `${binary} auth login`;
  }

  /**
   * Spawns the CLI as a long-lived child process and streams its stdout/stderr
   * to the UI in real time. Resolves when the process exits (the exit code
   * tells us whether the device-flow authorization completed), is aborted, or
   * trips the fallback watchdog timeout. Returns the raw execution outcome;
   * callers translate it into a structured LarkCliResult.
   */
  private runStreaming(
    cmdString: string,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<RawRunResult> {
    return new Promise<RawRunResult>((resolve) => {
      const child = spawn(cmdString, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let combined = '';
      let authUrl: string | undefined;
      let lastUpdateTime = 0;
      let settled = false;

      const flush = (force = false) => {
        if (!updateOutput) return;
        const now = Date.now();
        if (!force && now - lastUpdateTime < OUTPUT_UPDATE_INTERVAL_MS) return;
        lastUpdateTime = now;
        // When we have already captured an auth URL, keep it pinned at the top
        // so the user always sees the actionable link while the process waits.
        const banner = authUrl
          ? `🔑 Authorization required — open this URL to continue:\n${authUrl}\n\n`
          : '';
        updateOutput(banner + combined);
      };

      const onData = (buf: Buffer, isErr: boolean) => {
        const str = buf.toString('utf8');
        if (isErr) {
          stderr += str;
        } else {
          stdout += str;
        }
        combined += str;

        // Capture the authorization URL the instant it is printed and push it
        // to the user immediately (force flush, bypassing throttle).
        if (!authUrl) {
          const match = combined.match(AUTH_URL_REGEX);
          if (match) {
            authUrl = match[0];
            flush(true);
            return;
          }
        }
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

      // Fallback watchdog: guard against a permanently hung process. Normal
      // commands finish in milliseconds; only a stuck device-flow would linger.
      const timeoutId = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killChild();
      }, FALLBACK_TIMEOUT_MS);

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
        const errMessage = err.message || 'Failed to launch lark-cli';
        resolve({
          code: null,
          stdout,
          stderr,
          authUrl,
          timedOut,
          aborted,
          launchError: errMessage,
        });
      });

      child.on('exit', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        flush(true);
        resolve({ code, stdout, stderr, authUrl, timedOut, aborted });
      });
    });
  }

  /**
   * Translates the terminated child process into a structured LarkCliResult.
   */
  private buildResult(ctx: RawRunResult): LarkCliResult {
    const { code, stdout, stderr, authUrl, timedOut, aborted, launchError } =
      ctx;
    const output = stdout.trim();

    if (launchError) {
      const data = { status: 'failed', error: launchError, stderr };
      return {
        status: 'failed',
        error: launchError,
        llmContent: JSON.stringify(data),
        returnDisplay: `❌ lark-cli execution failed: ${launchError}`,
        summary: 'Failed',
      };
    }

    if (timedOut) {
      const errMessage = `lark-cli timed out after ${FALLBACK_TIMEOUT_MS / 60000} minutes`;
      const data = { status: 'failed', error: errMessage, stderr };
      return {
        status: 'failed',
        error: errMessage,
        llmContent: JSON.stringify(data),
        returnDisplay: `❌ ${errMessage}`,
        summary: 'Timed out',
      };
    }

    if (aborted) {
      const errMessage = 'lark-cli execution was cancelled';
      const data = { status: 'failed', error: errMessage, stderr };
      return {
        status: 'failed',
        error: errMessage,
        llmContent: JSON.stringify(data),
        returnDisplay: `⏹️ ${errMessage}`,
        summary: 'Cancelled',
      };
    }

    // Successful exit. If an auth URL was seen and exit code is 0, the
    // device-flow authorization completed successfully.
    if (code === 0) {
      let parsedData: any;
      try {
        parsedData = JSON.parse(output || '{}');
      } catch {
        parsedData = { rawOutput: output };
      }

      const result: LarkCliResult = {
        status: 'success',
        data: parsedData,
        llmContent: JSON.stringify({ status: 'success', data: parsedData }),
        returnDisplay: output || 'lark-cli executed successfully.',
        summary: 'Success',
      };
      if (authUrl) {
        result.authUrl = authUrl;
      }
      return result;
    }

    // Non-zero exit. If we captured an auth URL, the user likely has not
    // finished authorizing yet — surface it as auth_required so the agent can
    // re-prompt instead of treating it as a hard failure.
    if (authUrl) {
      const data = { status: 'auth_required', authUrl };
      return {
        status: 'auth_required',
        authUrl,
        llmContent: JSON.stringify(data),
        returnDisplay: `🔑 Authentication Required: Please authorize via: ${authUrl}`,
        summary: 'Auth Required',
      };
    }

    const errMessage =
      stderr.trim() || output || `lark-cli exited with code ${code}`;

    // Enrich the error with structured hints from lark-cli's JSON error
    // response so the AI can self-correct instead of guessing. lark-cli
    // returns errors like:
    //   { error: { type: "unknown_subcommand", message: "...",
    //     hint: "available subcommands: +agenda, +create, ...",
    //     detail: { available: [...], unknown: "list" } } }
    // or:
    //   { error: { type: "validation", message: "unknown flag: --date",
    //     hint: "..." } }
    let enrichedHint = '';

    if (errMessage.toLowerCase().includes('pending approval')) {
      enrichedHint += `\n\n🔒 CRITICAL INFO FOR USER & AI:\nThe Feishu/Lark application is currently pending approval by your corporate enterprise administrator.\n👉 Action required: Please contact your IT/Feishu administrator to approve this custom app in the Feishu Admin Console (飞书管理后台 - 版本管理与发布) first, then run this command again. Do NOT try other authentication or login commands because they will also be blocked until approved.`;
    }

    try {
      const parsed = JSON.parse(errMessage);
      const errObj = parsed?.error;
      if (errObj) {
        if (errObj.hint) {
          enrichedHint += `\n💡 Hint: ${errObj.hint}`;
        }
        if (errObj.detail?.available) {
          enrichedHint += `\n📋 Available: ${errObj.detail.available.join(', ')}`;
        }
        if (errObj.message && !errMessage.includes(errObj.message)) {
          enrichedHint += `\n📄 ${errObj.message}`;
        }
      }
    } catch {
      // Not JSON — nothing to enrich.
    }

    const enrichedMessage = enrichedHint
      ? `${errMessage}${enrichedHint}`
      : errMessage;

    const data = { status: 'failed', error: enrichedMessage, stderr };
    return {
      status: 'failed',
      error: enrichedMessage,
      llmContent: JSON.stringify(data),
      returnDisplay: `❌ lark-cli execution failed: ${enrichedMessage}`,
      summary: 'Failed',
    };
  }
}
