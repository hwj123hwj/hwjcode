/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书凭证管理 — 持久化 App ID / App Secret / Domain / 授权策略
 *
 * 安全模型（重要）：
 *   - 凭证文件以 0o600 (owner read/write only) 写入磁盘。
 *   - 文件本身使用 AES-256-GCM 做对称加密 + 完整性校验，密钥派生自一个
 *     一次性生成的 256-bit 随机字节，与凭证文件存放在同一目录下并同样
 *     设为 0o600。
 *   - **请理解此加密的真实威胁模型**：因密钥与密文同位，加密的主要价值
 *     是抵御"路径意外泄露 / cat 输出 / 备份扫描"等被动暴露场景，
 *     无法抵御能读取整个 ~/.deepv 目录的攻击者。要更高安全等级请走
 *     OS keychain（macOS Keychain / Windows DPAPI / libsecret），
 *     这个工程改动较大，目前未实现。
 *
 *   - 历史版本使用 AES-256-CBC（无完整性校验）。本模块保持向后兼容：
 *     读取时自动识别两种格式，写入时统一升级为 GCM。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  /** 扫码建应用时拿到的 bot 信息 */
  botName?: string;
  botOpenId?: string;
  /** 手动输入时探测到的租户名 */
  tenantName?: string;
  /**
   * Bot 拥有者的飞书 open_id —— 通常是 setup 时扫码用户的 open_id。
   * 用于授权检查：默认仅此 open_id 可以触发 Bot 的 LLM/工具调用。
   */
  ownerOpenId?: string;
  /**
   * 标记 {@link ownerOpenId} 是否已在 **Bot 应用自身的 open_id 空间** 完成确认。
   *
   * 飞书 open_id 按应用隔离：同一个人在不同应用下 open_id 不同。扫码 setup 时
   * 拿到的 open_id 来自 dvcode 注册流（另一个应用的 id 空间），无法与 Bot 应用
   * `im.message.receive_v1` 事件里的 sender open_id 匹配，因此 setup 时置为
   * `false`，表示"owner open_id 只是注册态猜测，待首次私聊确认"。收到 owner 的
   * 首条私聊后，把 ownerOpenId 绑定为真实的 Bot 应用 open_id 并置 `true`。
   *
   * 旧凭证缺省此字段（undefined）按"已确认"处理，避免升级后被重新绑定（防劫持）。
   */
  ownerVerified?: boolean;
  /**
   * 额外的授权 open_id 白名单（除 ownerOpenId 外）。
   * 通过 `/feishu allow <openId>` 添加；`/feishu deny <openId>` 移除。
   */
  allowlist?: string[];
}

const FEISHU_CREDENTIALS_FILE = 'feishu-credentials.json';
const ENCRYPTION_KEY_FILE = 'feishu-key';

/**
 * 飞书凭证统一存放在用户全局目录 `~/.deepv/`。
 *
 * 命名约定（重要，避免混淆）：
 *   - 全局：`<home>/.deepv/`        ← 这里
 *   - 项目：`<projectRoot>/.deepvcode/`
 * 飞书 Bot 凭证不区分项目，固定走全局，因此不接受 projectRoot 形参。
 */
function credDir(): string {
  return path.join(os.homedir(), '.easycode-user');
}

function credPath(): string {
  return path.join(credDir(), FEISHU_CREDENTIALS_FILE);
}

function keyPath(): string {
  return path.join(credDir(), ENCRYPTION_KEY_FILE);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const dir = credDir();
  const kp = keyPath();
  await fs.mkdir(dir, { recursive: true });
  try {
    const existing = await fs.readFile(kp);
    return existing;
  } catch {
    const key = crypto.randomBytes(32);
    await fs.writeFile(kp, key, { mode: 0o600 });
    return key;
  }
}

// --- AES-256-GCM (current format) ---

const GCM_PREFIX = 'gcm:';
const GCM_IV_BYTES = 12; // recommended for GCM

function encryptGcm(data: string, key: Buffer): string {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${GCM_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptGcm(payload: string, key: Buffer): string {
  const body = payload.slice(GCM_PREFIX.length);
  const [ivHex, tagHex, encHex] = body.split(':');
  if (!ivHex || !tagHex || !encHex) {
    throw new Error('Malformed GCM payload');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// --- AES-256-CBC (legacy format, read-only support) ---

function decryptCbcLegacy(payload: string, key: Buffer): string {
  const [ivHex, encHex] = payload.split(':');
  if (!ivHex || !encHex) {
    throw new Error('Malformed CBC payload');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Distinguishes "credentials not yet configured" from "credentials are
 * present but cannot be decrypted" so callers can show actionable errors.
 */
export class CredentialsLoadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CredentialsLoadError';
  }
}

/**
 * Returns null when the credentials file does not exist.
 * Throws CredentialsLoadError on decryption / parse failure (so users
 * can be told to run `/feishu logout` and re-setup).
 */
export async function loadCredentials(): Promise<FeishuCredentials | null> {
  let encrypted: string;
  try {
    encrypted = (await fs.readFile(credPath(), 'utf8')).trim();
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw new CredentialsLoadError(
      `Failed to read Feishu credentials: ${(e as Error).message}`,
      e,
    );
  }

  let key: Buffer;
  try {
    key = await loadOrCreateKey();
  } catch (e: unknown) {
    throw new CredentialsLoadError(
      `Failed to read Feishu encryption key: ${(e as Error).message}`,
      e,
    );
  }

  try {
    const json = encrypted.startsWith(GCM_PREFIX)
      ? decryptGcm(encrypted, key)
      : decryptCbcLegacy(encrypted, key);
    return JSON.parse(json) as FeishuCredentials;
  } catch (e: unknown) {
    throw new CredentialsLoadError(
      'Feishu credentials file is corrupted or was encrypted with a different key. ' +
        'Run `/feishu logout` to clear and re-setup.',
      e,
    );
  }
}

export async function saveCredentials(
  creds: FeishuCredentials,
): Promise<void> {
  await fs.mkdir(credDir(), { recursive: true });
  const key = await loadOrCreateKey();
  const json = JSON.stringify(creds);
  const encrypted = encryptGcm(json, key);
  await fs.writeFile(credPath(), encrypted, { mode: 0o600 });
}

export async function clearCredentials(): Promise<void> {
  try {
    await fs.unlink(credPath());
  } catch {
    // ignore
  }
}

/**
 * Authorization helper: returns true if the given Feishu open_id is allowed
 * to invoke the Bot's LLM/agent capabilities.
 *
 * Allowed iff:
 *   - openId equals creds.ownerOpenId, OR
 *   - openId is in creds.allowlist.
 *
 * If neither field is set (e.g. legacy credentials), we deny by default and
 * caller should prompt user to run `/feishu allow self` or upgrade.
 */
export function isSenderAuthorized(
  creds: FeishuCredentials,
  senderOpenId: string,
): boolean {
  if (!senderOpenId) return false;
  if (creds.ownerOpenId && creds.ownerOpenId === senderOpenId) return true;
  if (creds.allowlist?.includes(senderOpenId)) return true;
  return false;
}

/**
 * 是否应把这条消息的发送者「首次使用即绑定」（Trust-On-First-Use）为已验证的
 * Bot 拥有者。
 *
 * 为什么需要它 —— 飞书 open_id **按应用隔离**：同一个人在每个应用下的 open_id
 * 都不同。setup 时记录的 owner open_id 来自 device-code *注册流*（dvcode 平台
 * 应用的 id 空间），而非 Bot 应用本身，因此永远无法与 Bot 应用在
 * `im.message.receive_v1` 里看到的 `sender_id.open_id` 匹配——真正的群主会被
 * 误判为"非授权用户"。owner 的 **Bot 应用 open_id 只能从 Bot 应用自身的事件里
 * 拿到**，故在首次使用时绑定。
 *
 * 安全约束：
 *   - 仅 p2p（私聊）可声明所有权：刚建好的 PersonalAgent 只有创建者知道，首条
 *     私聊几乎必定来自 owner；若允许群消息声明所有权，任何群成员都能劫持 Bot。
 *   - 仅当 `ownerVerified === false` 时——该标记只由 setup 路径写入，含义是
 *     "owner open_id 是注册态猜测，待首次确认"。旧凭证（字段缺省）按"已确认"
 *     处理，确保升级不会把一个已正常工作的 Bot 静默重新绑定给先发消息的人。
 */
export function shouldAutoBindOwner(
  creds: FeishuCredentials,
  senderOpenId: string,
  chatType: 'p2p' | 'group' | 'topic',
): boolean {
  if (!senderOpenId) return false;
  if (chatType !== 'p2p') return false;
  return creds.ownerVerified === false;
}
