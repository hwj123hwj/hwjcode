/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Desktop-side management of the Feishu/Lark gateway.
 *
 * The gateway itself is the CLI's job: we drive `easycode --feishu` exactly the
 * way the ACP backend is driven (Electron-as-Node running the bundled
 * `easycode.js`). This module owns that long-running child plus the side
 * concerns the UI needs:
 *   - read/write the shared encrypted credential store (`~/.easycode-user/
 *     feishu-credentials.json`) so the desktop can set up creds without the TUI;
 *   - the QR device-code registration flow + manual-credential probe (plain
 *     `fetch`, mirrors `packages/cli/src/services/feishu/registration.ts`);
 *   - detect a gateway started independently by the CLI (a stray `--feishu`
 *     process) and shut it down — one machine must run exactly one gateway or
 *     Feishu message routing gets split-brained.
 *
 * Nothing here imports the CLI: the credential encryption and registration
 * protocol are reproduced from first principles so they stay byte-compatible
 * with the store the CLI reads/writes.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { resolveBackendEntry } from './backendLocator.js';
import {
  isAllowedFeishuAuthCommand,
  buildFeishuCommandArgs,
  parseFeishuCommandStdout,
} from './feishuCommandRunner.js';
import type {
  FeishuBinding,
  FeishuDomain,
  FeishuExternalProcess,
  FeishuLobby,
  FeishuManualInput,
  FeishuQrBegin,
  FeishuQrBeginResult,
  FeishuResult,
  FeishuRunResult,
  FeishuStatus,
} from '../shared/ipc.js';

const execFileP = promisify(execFile);

// ── credential store (byte-compatible with the CLI) ────────────────────────

interface StoredCredentials {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  botName?: string;
  botOpenId?: string;
  tenantName?: string;
  ownerOpenId?: string;
  /**
   * Whether {@link ownerOpenId} has been confirmed in the Bot app's own open_id
   * space (TOFU first-DM binding). Must round-trip through every save path —
   * dropping it would let the gateway re-bind a confirmed owner to whoever DMs
   * next. Mirrors FeishuCredentials.ownerVerified in the CLI store.
   */
  ownerVerified?: boolean;
  allowlist?: string[];
}

const CRED_FILE = 'feishu-credentials.json';
const KEY_FILE = 'feishu-key';
const GCM_PREFIX = 'gcm:';

function credDir(): string {
  return path.join(os.homedir(), '.easycode-user');
}

async function loadOrCreateKey(): Promise<Buffer> {
  const dir = credDir();
  await fs.mkdir(dir, { recursive: true });
  const kp = path.join(dir, KEY_FILE);
  try {
    return await fs.readFile(kp);
  } catch {
    const key = crypto.randomBytes(32);
    await fs.writeFile(kp, key, { mode: 0o600 });
    return key;
  }
}

function encryptGcm(data: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${GCM_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(payload: string, key: Buffer): string {
  if (payload.startsWith(GCM_PREFIX)) {
    const [ivHex, tagHex, encHex] = payload.slice(GCM_PREFIX.length).split(':');
    if (!ivHex || !tagHex || !encHex) throw new Error('Malformed GCM payload');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  }
  // Legacy AES-256-CBC (read-only compat with old CLI saves).
  const [ivHex, encHex] = payload.split(':');
  if (!ivHex || !encHex) throw new Error('Malformed CBC payload');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await fs.readFile(path.join(credDir(), CRED_FILE), 'utf8');
    const key = await loadOrCreateKey();
    const creds = JSON.parse(decrypt(raw.trim(), key)) as StoredCredentials;
    if (!creds.appId || !creds.appSecret) return null;
    return creds;
  } catch {
    return null;
  }
}

async function saveCredentials(creds: StoredCredentials): Promise<void> {
  const key = await loadOrCreateKey();
  const payload = encryptGcm(JSON.stringify(creds), key);
  await fs.writeFile(path.join(credDir(), CRED_FILE), payload, { mode: 0o600 });
}

async function clearCredentialsFile(): Promise<void> {
  await fs.unlink(path.join(credDir(), CRED_FILE)).catch(() => undefined);
}

// ── project↔chat route table + chat-name resolution (for the lobby panel) ────

const ROUTES_FILE = 'feishu-projects.json';

/** A route record as the CLI gateway writes it (we read a permissive subset). */
interface StoredRoute {
  projectRoot?: string;
  model?: string;
  agent?: string;
  lastSessionId?: string;
  lastSessionAt?: number;
}

/** Read the shared `feishu-projects.json` (chatId → route), tolerating absence. */
async function loadProjectRoutes(): Promise<Record<string, StoredRoute>> {
  try {
    const raw = await fs.readFile(path.join(credDir(), ROUTES_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, StoredRoute>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ── live "currently running" session state (written by the gateway child) ────

/**
 * The gateway writes `feishu-active.json` whenever its set of in-flight chats
 * changes: `{ pid, updatedAt, chatIds }`. We read it to mark which bindings are
 * *currently running a session* — the GUI counterpart of the CLI TUI's green
 * "(Active)" indicator. `pid` lets us ignore stale state left by a previous
 * gateway process (see resolveActiveChatIds).
 */
const ACTIVE_FILE = 'feishu-active.json';

interface ActiveState {
  pid?: number;
  updatedAt?: number;
  chatIds?: string[];
}

async function loadActiveChats(): Promise<ActiveState> {
  try {
    const raw = await fs.readFile(path.join(credDir(), ACTIVE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as ActiveState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Resolved chat name / mode, cached so the lobby doesn't re-hit the API every
// refresh. Mirrors gateway.ts#fetchAndCacheChatInfo (one GET fills both).
const chatInfoCache = new Map<string, { name?: string; mode?: string }>();
let tokenCache: { token: string; expiresAt: number } | null = null;

async function tenantAccessToken(creds: StoredCredentials): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.token;
  const openBase = openBaseFor(creds.domain);
  try {
    const res = await fetch(`${openBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    });
    const data: any = await res.json();
    const token: string | undefined = data.tenant_access_token;
    if (!token) return null;
    tokenCache = { token, expiresAt: Date.now() + (Number(data.expire) || 3600) * 1000 };
    return token;
  } catch {
    return null;
  }
}

/** Resolve names/modes for any not-yet-cached chatIds (best effort, parallel). */
async function resolveChatInfo(chatIds: string[], creds: StoredCredentials): Promise<void> {
  const missing = chatIds.filter((id) => id && !chatInfoCache.has(id));
  if (missing.length === 0) return;
  const token = await tenantAccessToken(creds);
  if (!token) return;
  const openBase = openBaseFor(creds.domain);
  await Promise.all(
    missing.map(async (id) => {
      try {
        const res = await fetch(`${openBase}/open-apis/im/v1/chats/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data: any = await res.json();
        if (data.code !== 0) {
          chatInfoCache.set(id, {});
          return;
        }
        const name = typeof data.data?.name === 'string' ? data.data.name.trim() : '';
        const mode = typeof data.data?.chat_mode === 'string' ? data.data.chat_mode.trim() : '';
        chatInfoCache.set(id, { name: name || undefined, mode: mode || undefined });
      } catch {
        /* leave unresolved so a later refresh can retry */
      }
    }),
  );
}

// ── Feishu registration / probe (mirrors registration.ts, plain fetch) ──────

const ACCOUNTS_URLS: Record<string, string> = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
};
const REGISTRATION_PATH = '/oauth/v1/app/registration';
const TP_TAG = 'dvcode';

function openBaseFor(domain: string): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

async function postRegistration(domain: string, body: Record<string, string>): Promise<any> {
  const baseUrl = ACCOUNTS_URLS[domain] || ACCOUNTS_URLS.feishu;
  const res = await fetch(`${baseUrl}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`注册端点返回非 JSON (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }
}

async function initRegistration(domain: FeishuDomain): Promise<void> {
  const res = await postRegistration(domain, { action: 'init' });
  const methods: string[] = res.supported_auth_methods || [];
  if (!methods.includes('client_secret')) {
    throw new Error(`当前飞书注册环境不支持 client_secret 认证（支持: ${methods.join(', ') || '无'}）。`);
  }
}

async function beginRegistration(domain: FeishuDomain): Promise<FeishuQrBegin> {
  const res = await postRegistration(domain, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id tenant_brand',
  });
  const deviceCode = res.device_code;
  if (!deviceCode) throw new Error('飞书注册未返回 device_code。');
  let qrUrl: string = res.verification_uri_complete || '';
  if (qrUrl) {
    const sep = qrUrl.includes('?') ? '&' : '?';
    qrUrl = `${qrUrl}${sep}from=${TP_TAG}&tp=${TP_TAG}`;
  } else {
    qrUrl = `${openBaseFor(domain)}/page/launcher?user_code=${res.user_code}&from=${TP_TAG}&tp=${TP_TAG}`;
  }
  return {
    deviceCode,
    qrUrl,
    userCode: res.user_code || '',
    interval: res.interval || 5,
    expireIn: res.expires_in || res.expire_in || 600,
    domain,
  };
}

interface PollOk {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  openId?: string;
}

async function pollRegistration(begin: FeishuQrBegin, cancelled: () => boolean): Promise<PollOk | null> {
  const deadline = Date.now() + begin.expireIn * 1000;
  let currentDomain: FeishuDomain = begin.domain;
  let switched = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  while (Date.now() < deadline) {
    if (cancelled()) return null;
    let res: any;
    try {
      res = await postRegistration(currentDomain, { action: 'poll', device_code: begin.deviceCode });
    } catch {
      await sleep(begin.interval * 1000);
      continue;
    }
    const userInfo = res.user_info || {};
    if (userInfo.tenant_brand === 'lark' && !switched) {
      currentDomain = 'lark';
      switched = true;
    }
    if (res.client_id && res.client_secret) {
      return { appId: res.client_id, appSecret: res.client_secret, domain: currentDomain, openId: userInfo.open_id };
    }
    const error: string = res.error || '';
    if (error === 'access_denied' || error === 'expired_token') return null;
    await sleep(begin.interval * 1000);
  }
  return null;
}

async function probeCredentials(
  appId: string,
  appSecret: string,
  domain: FeishuDomain,
): Promise<{ botName?: string; botOpenId?: string } | null> {
  const openBase = openBaseFor(domain);
  try {
    const tokenRes = await fetch(`${openBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenData: any = await tokenRes.json();
    const accessToken: string | undefined = tokenData.tenant_access_token;
    if (!accessToken) return null;

    const botRes = await fetch(`${openBase}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const botData: any = await botRes.json();
    if (botData.code !== 0) return null;
    const bot = botData.bot || botData.data?.bot || {};
    return { botName: bot.app_name || bot.bot_name, botOpenId: bot.open_id };
  } catch {
    return null;
  }
}

// ── process detection / kill ────────────────────────────────────────────────

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// CSI sequences (ESC [ ... letter) and OSC sequences (ESC ] ... BEL). Built from
// char codes so this source file carries no literal control bytes.
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^${BEL}]*${BEL}?`, 'g');

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** The gateway flag, assembled at runtime so the literal never appears verbatim
 * in our own detection command line (otherwise the PowerShell/ps helper that
 * runs the query would match itself — a false positive). */
const FEISHU_FLAG = '--fei' + 'shu';

/**
 * A real gateway is `easycode --feishu` — the flag must be a standalone token,
 * not just a substring (so a path like `C:\--feishu-notes\x` never matches).
 */
function isFeishuGatewayCmd(cmd: string): boolean {
  return new RegExp(`(?:^|\\s)${FEISHU_FLAG}(?:\\s|$)`).test(cmd);
}

/** Find live `--feishu` gateway processes, excluding our own managed child and
 * this desktop process. */
async function findFeishuProcesses(excludePid?: number): Promise<FeishuExternalProcess[]> {
  const out: FeishuExternalProcess[] = [];
  try {
    if (process.platform === 'win32') {
      // Build the `-like` pattern from pieces so this query's own PowerShell
      // command line does not contain a contiguous `--feishu` — that prevents
      // the helper process from matching (and reporting) itself.
      const psScript =
        `$pat = '*' + '${FEISHU_FLAG}' + '*'; ` +
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like $pat } ' +
        '| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
      const { stdout } = await execFileP(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      );
      const trimmed = stdout.trim();
      if (trimmed) {
        const parsed = JSON.parse(trimmed);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const p of arr) {
          const pid = Number(p.ProcessId);
          if (Number.isInteger(pid)) out.push({ pid, cmd: String(p.CommandLine ?? '') });
        }
      }
    } else {
      const { stdout } = await execFileP('ps', ['-axww', '-o', 'pid=,command='], {
        maxBuffer: 8 * 1024 * 1024,
      });
      for (const line of stdout.split('\n')) {
        if (!line.includes(FEISHU_FLAG)) continue;
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
      }
    }
  } catch {
    /* best effort — detection failing must not block start/stop */
  }
  // Only count processes that genuinely carry the `--feishu` flag as a token,
  // and never our own managed gateway or this desktop process.
  return out.filter(
    (p) => p.pid !== excludePid && p.pid !== process.pid && isFeishuGatewayCmd(p.cmd),
  );
}

async function killPid(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await execFileP('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Sentinel exit code a desktop-managed gateway uses to ask us (its parent) to
 * restart it, instead of self-spawning a standalone CLI gateway via the relaunch
 * helper. Set when the user runs `/feishu restart` inside Feishu.
 *
 * Must match FEISHU_DESKTOP_RESTART_EXIT_CODE in
 * packages/cli/src/ui/commands/feishuCommand.ts.
 */
const FEISHU_RESTART_EXIT_CODE = 97;

/** How much of the gateway child's combined stdout/stderr we keep and surface
 * to the UI's "details" panel. Big enough for the full WebSocket connect
 * handshake + a stack trace, bounded so a chatty gateway can't grow unbounded. */
const LOG_TAIL_MAX = 16_000;

/** Min gap between log-driven status pushes, so a noisy child doesn't flood the
 * IPC channel / React re-renders. The tail is always complete on the next tick;
 * this only rate-limits how often we notify. */
const LOG_EMIT_THROTTLE_MS = 250;

// ── the manager ──────────────────────────────────────────────────────────────

export class FeishuManager {
  private child?: ChildProcess;
  private startedAt?: number;
  private lastError?: string;
  private logTail = '';
  private pollCancelled = false;
  private stopping = false;
  private logEmitTimer?: NodeJS.Timeout;
  private logEmitPending = false;

  constructor(
    private readonly onChange: (status: FeishuStatus) => void,
    private readonly log: (line: string) => void,
  ) {}

  private get running(): boolean {
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  private appendLog(chunk: Buffer): void {
    const text = stripAnsi(chunk.toString('utf8'));
    if (!text.trim()) return;
    this.logTail = (this.logTail + text).slice(-LOG_TAIL_MAX);
    // Stream live output to the UI so the user can watch the gateway actually
    // boot (WebSocket connect, scope audit, crashes) instead of only seeing a
    // static "running" badge. Throttled to avoid flooding IPC on a chatty child.
    this.scheduleLogEmit();
  }

  /** Push the latest status (carrying logTail) to the UI, at most once per
   * LOG_EMIT_THROTTLE_MS while output keeps arriving. */
  private scheduleLogEmit(): void {
    if (this.logEmitTimer) {
      this.logEmitPending = true;
      return;
    }
    this.emitChange();
    this.logEmitTimer = setTimeout(() => {
      this.logEmitTimer = undefined;
      if (this.logEmitPending) {
        this.logEmitPending = false;
        this.scheduleLogEmit();
      }
    }, LOG_EMIT_THROTTLE_MS);
  }

  async getStatus(): Promise<FeishuStatus> {
    const creds = await loadCredentials();
    return {
      credsConfigured: !!creds,
      botName: creds?.botName,
      platform: creds?.domain,
      ownerOpenId: creds?.ownerOpenId,
      ownerVerified: creds?.ownerVerified,
      allowlistCount: creds?.allowlist?.length ?? 0,
      allowlist: creds?.allowlist ?? [],
      running: this.running,
      pid: this.running ? this.child?.pid : undefined,
      startedAt: this.running ? this.startedAt : undefined,
      lastError: this.lastError,
      logTail: this.logTail,
    };
  }

  private emitChange(): void {
    void this.getStatus().then((s) => this.onChange(s));
  }

  async saveManualCredentials(input: FeishuManualInput): Promise<FeishuResult> {
    const probe = await probeCredentials(input.appId.trim(), input.appSecret.trim(), input.domain);
    if (!probe) {
      return {
        ok: false,
        error: '凭证无效：无法获取 tenant_access_token 或读取 Bot 信息，请检查 App ID / App Secret 与平台。',
      };
    }
    const existing = await loadCredentials();
    await saveCredentials({
      appId: input.appId.trim(),
      appSecret: input.appSecret.trim(),
      domain: input.domain,
      botName: probe.botName,
      botOpenId: probe.botOpenId,
      ownerOpenId: existing?.ownerOpenId,
      ownerVerified: existing?.ownerVerified,
      allowlist: existing?.allowlist,
    });
    this.lastError = undefined;
    this.emitChange();
    return { ok: true, status: await this.getStatus() };
  }

  async qrBegin(domain: FeishuDomain): Promise<FeishuQrBeginResult> {
    try {
      this.pollCancelled = false;
      // Honor the platform the user picked in the UI: Feishu (国内) begins on
      // accounts.feishu.cn, Lark (国际) on accounts.larksuite.com. Both are
      // valid device-code registration endpoints — verified against the
      // official @larksuiteoapi/node-sdk, whose DEFAULT_LARK_DOMAIN is exactly
      // accounts.larksuite.com. Seeding from the chosen domain makes the QR,
      // the open-platform it points at, and the saved credential all consistent
      // (picking Lark now yields an open.larksuite.com QR, not open.feishu.cn).
      //
      // pollRegistration still auto-switches to lark if the scanner's
      // tenant_brand says so, so a feishu-seeded scan by a Lark user is also
      // resolved correctly — but we no longer force everyone through feishu.
      await initRegistration(domain);
      const begin = await beginRegistration(domain);
      return { ok: true, begin };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  async qrPoll(begin: FeishuQrBegin): Promise<FeishuResult> {
    try {
      const res = await pollRegistration(begin, () => this.pollCancelled);
      if (!res) {
        return { ok: false, error: this.pollCancelled ? '已取消扫码登录。' : '扫码超时或被拒绝，请重试。' };
      }
      const probe = (await probeCredentials(res.appId, res.appSecret, res.domain)) ?? {};
      const existing = await loadCredentials();
      await saveCredentials({
        appId: res.appId,
        appSecret: res.appSecret,
        domain: res.domain,
        botName: probe.botName,
        botOpenId: probe.botOpenId,
        ownerOpenId: res.openId ?? existing?.ownerOpenId,
        // A freshly scanned open_id comes from the dvcode registration flow's
        // id space (not the Bot app's), so it's a guess awaiting first-DM TOFU
        // confirmation — mark it unverified, mirroring the CLI's QR setup. When
        // the scan returned no open_id we keep whatever was already confirmed.
        ownerVerified: res.openId ? false : existing?.ownerVerified,
        allowlist: existing?.allowlist,
      });
      this.lastError = undefined;
      this.emitChange();
      return { ok: true, status: await this.getStatus() };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  qrCancel(): void {
    this.pollCancelled = true;
  }

  async clearCredentials(): Promise<FeishuStatus> {
    await clearCredentialsFile();
    this.emitChange();
    return this.getStatus();
  }

  /**
   * Run a `/feishu` authorization subcommand (allow / deny / owner / allowlist)
   * by spawning the bundled backend non-interactively — the exact same handlers
   * the CLI/TUI use, loaded via BuiltinCommandLoader. The command mutates the
   * shared credential store; we re-read status afterwards so the UI reflects it.
   *
   * This is pass-through, not a reimplementation: the owner-guard, dedupe,
   * "set as owner when none", "cannot remove owner" rules all live in
   * feishuCommand.ts and stay single-sourced.
   *
   * NOTE: a *running* gateway holds its credentials in an in-memory snapshot and
   * does not re-read per message, so a change here only affects live sessions
   * after the gateway is restarted. The dialog surfaces that hint.
   */
  async runFeishuCommand(rawArgs: string): Promise<FeishuRunResult> {
    const args = (rawArgs ?? '').trim();
    if (!isAllowedFeishuAuthCommand(args)) {
      return {
        ok: false,
        error: `不支持的 /feishu 子命令：${args || '(空)'}`,
        status: await this.getStatus(),
      };
    }
    const creds = await loadCredentials();
    if (!creds) {
      return { ok: false, error: '尚未配置飞书凭证。', status: await this.getStatus() };
    }

    let entry: string;
    try {
      entry = resolveBackendEntry();
    } catch (e) {
      return { ok: false, error: errMsg(e), status: await this.getStatus() };
    }

    const spawnArgs = buildFeishuCommandArgs(entry, args);
    const { code, stdout, stderr } = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      const finish = (c: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code: c, stdout: out, stderr: err });
      };
      const child = spawn(process.execPath, spawnArgs, {
        cwd: os.homedir(),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ...(process.env.DEEPX_SERVER_URL ? { DEEPX_SERVER_URL: process.env.DEEPX_SERVER_URL } : {}),
          ...(process.env.DEEPX_WEB_URL ? { DEEPX_WEB_URL: process.env.DEEPX_WEB_URL } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // Bound the wait so a wedged backend boot can't hang the IPC call forever.
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish(null);
      }, 60_000);
      child.stdout?.on('data', (b: Buffer) => {
        out += b.toString('utf8');
      });
      child.stderr?.on('data', (b: Buffer) => {
        err += b.toString('utf8');
      });
      child.on('error', (e) => {
        err += errMsg(e);
        finish(-1);
      });
      child.on('close', (c) => finish(c));
    });

    const parsed = parseFeishuCommandStdout(stripAnsi(stdout));
    // Credentials may have changed on disk — refresh the broadcast status and
    // hand the caller a fresh snapshot so the dialog re-renders owner/allowlist.
    this.emitChange();
    const status = await this.getStatus();

    if (parsed.message && parsed.status !== 'error') {
      return { ok: true, message: parsed.message, status };
    }
    const error =
      parsed.error ||
      parsed.message ||
      stripAnsi(stderr).trim().split('\n').filter(Boolean).slice(-3).join('\n') ||
      `命令执行失败 (exit ${code ?? 'null'})`;
    return { ok: false, error, status };
  }

  detectExternal(): Promise<FeishuExternalProcess[]> {
    return findFeishuProcesses(this.child?.pid);
  }

  /**
   * Build the lobby view: every project↔chat binding from the shared route
   * table, enriched with resolved chat names, newest activity first. The GUI
   * counterpart of the CLI's `FeishuStatusDashboard`.
   */
  async getLobby(): Promise<FeishuLobby> {
    const routes = await loadProjectRoutes();
    const chatIds = Object.keys(routes);
    if (chatIds.length > 0) {
      const creds = await loadCredentials();
      if (creds) await resolveChatInfo(chatIds, creds).catch(() => undefined);
    }
    const activeChatIds = await this.resolveActiveChatIds();
    const bindings: FeishuBinding[] = chatIds.map((chatId) => {
      const r = routes[chatId] ?? {};
      const info = chatInfoCache.get(chatId) ?? {};
      return {
        chatId,
        chatName: info.name,
        isP2p: info.mode === 'p2p',
        projectRoot: r.projectRoot,
        agent: r.agent,
        model: r.model,
        lastSessionId: r.lastSessionId,
        lastSessionAt: r.lastSessionAt,
        active: activeChatIds.has(chatId),
      };
    });
    // Running sessions first, then most-recent activity.
    bindings.sort(
      (a, b) =>
        Number(b.active ?? false) - Number(a.active ?? false) ||
        (b.lastSessionAt ?? 0) - (a.lastSessionAt ?? 0),
    );
    return { bindings };
  }

  /**
   * The set of chats currently running a session, per the gateway's live
   * `feishu-active.json`. Trusted only when *our* gateway child is running and
   * the file's pid matches it — otherwise it's stale state from a prior process.
   */
  private async resolveActiveChatIds(): Promise<Set<string>> {
    if (!this.running) return new Set();
    const state = await loadActiveChats();
    if (state.pid && this.child?.pid && state.pid !== this.child.pid) {
      return new Set();
    }
    return new Set(state.chatIds ?? []);
  }

  async killExternal(): Promise<number> {
    const procs = await this.detectExternal();
    for (const p of procs) await killPid(p.pid);
    if (procs.length) this.log(`关闭了 ${procs.length} 个外部飞书网关进程`);
    return procs.length;
  }

  async start(): Promise<FeishuResult> {
    const creds = await loadCredentials();
    if (!creds) return { ok: false, error: '尚未配置飞书凭证，请先扫码登录或手动录入。' };
    if (this.running) return { ok: true, status: await this.getStatus() };

    // One machine = one gateway. Kill any CLI-launched (or orphaned) gateway
    // before we spawn ours, so Feishu message routing is never split-brained.
    const killedExternal = await this.killExternal();
    if (killedExternal) await delay(800);

    try {
      const entry = resolveBackendEntry();
      const child = spawn(process.execPath, [entry, '--feishu', '--no-continue'], {
        cwd: os.homedir(),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          // Mark this gateway as desktop-managed. The CLI's `/feishu restart`
          // handler reads this to restart *under desktop* (exit with the
          // sentinel code below) instead of self-spawning a standalone CLI
          // gateway that would escape our management.
          EASYCODE_DESKTOP_MANAGED: '1',
          ...(process.env.DEEPX_SERVER_URL ? { DEEPX_SERVER_URL: process.env.DEEPX_SERVER_URL } : {}),
          ...(process.env.DEEPX_WEB_URL ? { DEEPX_WEB_URL: process.env.DEEPX_WEB_URL } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      this.startedAt = Date.now();
      this.lastError = undefined;
      this.stopping = false;
      this.logTail = '';

      child.stdout?.on('data', (b: Buffer) => this.appendLog(b));
      child.stderr?.on('data', (b: Buffer) => this.appendLog(b));
      child.on('error', (err) => {
        this.lastError = errMsg(err);
        this.log(`飞书网关启动错误: ${errMsg(err)}`);
      });
      child.on('exit', (code) => {
        const wasStopping = this.stopping;
        const restartRequested = code === FEISHU_RESTART_EXIT_CODE;
        this.log(`飞书网关已退出 (code ${code ?? 'null'})`);
        if (!wasStopping && !restartRequested && code && code !== 0) {
          this.lastError = `网关进程异常退出 (code ${code})`;
        }
        this.child = undefined;
        this.startedAt = undefined;
        this.emitChange();

        // In-Feishu `/feishu restart`: the gateway asked us to restart it rather
        // than self-spawning a standalone CLI gateway. Honor it so the restart
        // stays desktop-managed.
        if (restartRequested && !wasStopping) {
          this.log('收到飞书重启指令，正在由桌面端重启网关…');
          setTimeout(() => {
            void this.start().catch((e) => this.log(`重启网关失败: ${errMsg(e)}`));
          }, 500);
        }
      });

      // Surface an immediate crash (bad bundle, missing-creds blow-up, etc.).
      await delay(900);
      if (!this.running) {
        return { ok: false, error: this.lastError ?? '网关启动失败，请查看日志。', status: await this.getStatus() };
      }
      this.log(`飞书网关已启动 (pid ${child.pid})`);
      this.emitChange();
      return { ok: true, killedExternal, status: await this.getStatus() };
    } catch (e) {
      this.lastError = errMsg(e);
      this.emitChange();
      return { ok: false, error: errMsg(e) };
    }
  }

  async stop(): Promise<FeishuStatus> {
    this.stopping = true;
    const pid = this.child?.pid;
    if (pid) await killPid(pid);
    this.child = undefined;
    this.startedAt = undefined;
    this.emitChange();
    return this.getStatus();
  }

  dispose(): void {
    this.stopping = true;
    const pid = this.child?.pid;
    if (pid) void killPid(pid);
    this.child = undefined;
  }
}
