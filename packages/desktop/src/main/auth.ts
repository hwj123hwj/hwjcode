/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Auth for the desktop app.
 *
 * Two design goals from the spec:
 *   1. REUSE the CLI login. Credentials live in a shared on-disk store
 *      (`~/.easycode-user/`) managed by core's `ProxyAuthManager`. Both the
 *      desktop main process and every spawned `easycode --acp` backend read the
 *      same store, so a user already logged in via the CLI is logged in here
 *      with zero extra work — and a login performed here is visible to the CLI.
 *   2. OWN login entry. The desktop offers its own login UI backed by the same
 *      core primitives: an API-key login (`POST /auth/jwt/apikey-login`) and a
 *      browser/OAuth login via core's `AuthServer` (port 7862 select page).
 */

// Deep imports (not the barrel): the main process only needs auth. Importing
// `deepv-code-core` directly would evaluate the whole index — telemetry,
// opentelemetry-grpc exporters, tool registry — none of which the desktop main
// needs. Deep paths are allowed because core ships no "exports" map.
import { ProxyAuthManager } from 'deepv-code-core/dist/src/core/proxyAuth.js';
import { AuthServer } from 'deepv-code-core/dist/src/auth/login/authServer.js';
import { AuthTemplates } from 'deepv-code-core/dist/src/auth/login/templates/index.js';
import { getUserAgent } from 'deepv-code-core/dist/src/utils/userAgent.js';
import { shell } from 'electron';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { AuthStatus, DesktopUser } from '../shared/ipc.js';

/**
 * Point core's `AuthTemplates` at the real login page (`authSelectPage.html`)
 * so the browser login renders Easy Code's branded template instead of the
 * bare-bones fallback.
 *
 * Why this is needed: `AuthTemplates.loadTemplate()` finds the HTML by walking
 * paths derived from `globalThis.__dirname` (set only by the CLI's esbuild
 * banner — absent in core's plain `tsc` ESM dist) and `process.cwd()` (the
 * Electron launch dir, not the repo root). In the desktop main process neither
 * resolves, so it silently falls back to `generateBasicAuthSelectTemplate()`.
 *
 * The templates ship beside the compiled module at
 * `<core>/dist/src/auth/login/templates/authSelectPage.html`. `setBasePath`
 * probes `<base>/auth/login/templates/<file>`, so the base is core's
 * `dist/src` — derived from the resolved location of `authServer.js`
 * (`dist/src/auth/login/authServer.js`).
 */
function configureAuthTemplates(): void {
  try {
    const require = createRequire(import.meta.url);
    const authServerPath = require.resolve(
      'deepv-code-core/dist/src/auth/login/authServer.js',
    );
    // dist/src/auth/login/authServer.js -> dist/src
    const base = path.join(path.dirname(authServerPath), '..', '..');
    AuthTemplates.setBasePath(base);
  } catch (err) {
    console.warn('[auth] Failed to configure auth templates base path:', err);
  }
}
configureAuthTemplates();

export function getServerUrl(): string {
  return process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai';
}

function toDesktopUser(): DesktopUser | undefined {
  const info = ProxyAuthManager.getInstance().getUserInfo();
  if (!info) return undefined;
  return {
    userId: info.userId,
    name: info.name,
    email: info.email,
    avatar: info.avatar,
  };
}

export function getAuthStatus(): AuthStatus {
  const mgr = ProxyAuthManager.getInstance();
  return {
    loggedIn: mgr.isConfigured(),
    user: toDesktopUser(),
    serverUrl: getServerUrl(),
  };
}

/**
 * Non-interactive API-key login. Mirrors `--login <api-key>` in gemini.tsx:
 * exchange the key for a JWT at the proxy server, then persist via
 * ProxyAuthManager (which writes to the shared credential store).
 */
export async function loginWithApiKey(
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: 'API Key 不能为空' };

  const serverUrl = getServerUrl();
  try {
    const response = await fetch(`${serverUrl}/auth/jwt/apikey-login`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'User-Agent': safeUserAgent(),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, error: `登录失败 (HTTP ${response.status})${text ? ': ' + text : ''}` };
    }

    const data = (await response.json()) as {
      success?: boolean;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      message?: string;
      error?: string;
      user?: {
        openId?: string;
        userId?: string;
        name?: string;
        email?: string;
        avatar?: string;
      };
    };

    if (!data.success || !data.accessToken) {
      return { ok: false, error: data.message || data.error || '未知错误' };
    }

    const mgr = ProxyAuthManager.getInstance();
    mgr.setJwtTokenData({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresIn: data.expiresIn || 900,
    });
    if (data.user) {
      mgr.setUserInfo({
        openId: data.user.openId || data.user.userId || '',
        userId: data.user.userId || data.user.openId || '',
        name: data.user.name || '',
        enName: data.user.name,
        email: data.user.email,
        avatar: data.user.avatar,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function safeUserAgent(): string {
  try {
    return getUserAgent();
  } catch {
    return 'EasyCode-Desktop/1.0';
  }
}

/**
 * Browser/OAuth login. Starts core's `AuthServer` (which serves the provider
 * selection page on :7862 and handles the callback), opens it in the system
 * browser, and resolves the running server so we can stop it on cancel/success.
 */
class BrowserLoginSession {
  private server?: AuthServer;
  private unsubscribe?: () => void;

  async start(onSuccess: () => void): Promise<{ ok: boolean; url?: string; error?: string }> {
    try {
      await this.stop();
      const server = new AuthServer();
      await server.start();
      this.server = server;

      const mgr = ProxyAuthManager.getInstance();
      // onLoginSuccess fires once the callback server stores credentials.
      const handler = () => {
        try {
          onSuccess();
        } finally {
          void this.stop();
        }
      };
      mgr.onLoginSuccess(handler);
      // ProxyAuthManager.onLoginSuccess has no explicit unsubscribe; track a flag.
      this.unsubscribe = () => undefined;

      const url = `http://localhost:${server.getActualSelectPort()}`;
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (err) {
      await this.stop();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {
    try {
      this.unsubscribe?.();
    } catch {
      /* noop */
    }
    this.unsubscribe = undefined;
    try {
      this.server?.stop();
    } catch {
      /* noop */
    }
    this.server = undefined;
  }
}

const browserLogin = new BrowserLoginSession();

export async function startBrowserLogin(
  onSuccess: () => void,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  return browserLogin.start(onSuccess);
}

export async function cancelBrowserLogin(): Promise<void> {
  return browserLogin.stop();
}

export function logout(): void {
  try {
    ProxyAuthManager.getInstance().clear();
  } catch {
    /* best-effort */
  }
}

/** Register a callback for any credential change driven by core. */
export function onAuthChanged(cb: () => void): void {
  ProxyAuthManager.getInstance().onLoginSuccess(cb);
}
