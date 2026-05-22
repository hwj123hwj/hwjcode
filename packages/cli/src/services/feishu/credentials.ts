/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书凭证管理 — 安全存储 App ID / App Secret / Domain 到 ~/.deepv/feishu.json
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
}

const FEISHU_CREDENTIALS_FILE = 'feishu-credentials.json';
const ENCRYPTION_KEY_FILE = 'feishu-key';

function credDir(): string {
  return path.join(os.homedir(), '.deepv');
}

function credPath(): string {
  return path.join(credDir(), FEISHU_CREDENTIALS_FILE);
}

function keyPath(): string {
  return path.join(credDir(), ENCRYPTION_KEY_FILE);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const kp = keyPath();
  await fs.mkdir(credDir(), { recursive: true });
  try {
    const existing = await fs.readFile(kp);
    return existing;
  } catch {
    const key = crypto.randomBytes(32);
    await fs.writeFile(kp, key, { mode: 0o600 });
    return key;
  }
}

function encrypt(data: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(data: string, key: Buffer): string {
  const [ivHex, encHex] = data.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

export async function loadCredentials(): Promise<FeishuCredentials | null> {
  try {
    const key = await loadOrCreateKey();
    const encrypted = await fs.readFile(credPath(), 'utf8');
    const json = decrypt(encrypted.trim(), key);
    return JSON.parse(json) as FeishuCredentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: FeishuCredentials): Promise<void> {
  await fs.mkdir(credDir(), { recursive: true });
  const key = await loadOrCreateKey();
  const json = JSON.stringify(creds);
  const encrypted = encrypt(json, key);
  await fs.writeFile(credPath(), encrypted, { mode: 0o600 });
}

export async function clearCredentials(): Promise<void> {
  try {
    await fs.unlink(credPath());
  } catch {
    // ignore
  }
}
