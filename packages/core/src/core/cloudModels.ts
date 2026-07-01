/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CloudModelInfo } from '../config/config.js';
import { proxyAuthManager } from './proxyAuth.js';
import { isOurAuthError } from '../utils/errors.js';

/**
 * Default timeout for the `/web-api/models` request. The endpoint is normally
 * fast (<1s); 15s is a generous ceiling that keeps cold-start callers (e.g. the
 * ACP backend blocking `session/new` on a first-run fetch) responsive even on
 * flaky networks.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Raw `/web-api/models` entry shape — every field but `name` is optional. */
interface WebApiModelInfo {
  name?: unknown;
  displayName?: unknown;
  creditsPerRequest?: unknown;
  available?: unknown;
  maxToken?: unknown;
  highVolumeThreshold?: unknown;
  highVolumeCredits?: unknown;
}

interface WebApiModelsResponse {
  success?: boolean;
  data?: WebApiModelInfo[];
  message?: string;
}

export interface FetchCloudModelsOptions {
  /** Override the proxy base URL (mainly for testing). */
  baseUrl?: string;
  /** `User-Agent` header value. Defaults to `DeepCode`. */
  userAgent?: string;
  /** Timeout in milliseconds. Default 15s. */
  timeoutMs?: number;
  /** Optional AbortSignal merged with the internal timeout signal. */
  signal?: AbortSignal;
}

/**
 * Error thrown when the proxy `/web-api/models` call fails for any reason that
 * is NOT an authentication problem. Carries the HTTP status when available.
 */
export class CloudModelsFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CloudModelsFetchError';
  }
}

/**
 * Thrown when the proxy responds with HTTP 401 *and* the body is recognizably
 * one of our `AUTHENTICATION_FAILED` payloads (see {@link isOurAuthError}).
 * Callers should treat this as "the user must re-authenticate" rather than a
 * transient network error — the CLI maps it onto its `AuthenticationRequiredError`.
 */
export class CloudModelsAuthError extends CloudModelsFetchError {
  constructor(message = 'Authentication required - please re-authenticate') {
    super(message, 401);
    this.name = 'CloudModelsAuthError';
  }
}

/**
 * Fetch the authoritative list of models the proxy will accept from its
 * `/web-api/models` endpoint, normalize it, and sort by display name.
 *
 * This is the single source of truth shared by:
 *   - the interactive CLI (`/model` -> `refreshModelsInBackground`), and
 *   - the ACP backend (`refreshCloudModelsForAcp`, used by the desktop app).
 *
 * Authentication headers come from the shared {@link proxyAuthManager}; the
 * caller does not need to be logged in through any particular UI flow.
 *
 * @throws {CloudModelsAuthError} on a recognizable 401 (re-auth required).
 * @throws {CloudModelsFetchError} on any other network / HTTP / payload error.
 */
export async function fetchCloudModels(
  options: FetchCloudModelsOptions = {},
): Promise<CloudModelInfo[]> {
  const baseUrl = (options.baseUrl ?? proxyAuthManager.getProxyServerUrl() ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!baseUrl) {
    throw new CloudModelsFetchError('Proxy server URL is not configured');
  }

  const url = `${baseUrl}/web-api/models`;
  const userHeaders = await proxyAuthManager.getUserHeaders();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeoutController.abort(new Error(`Timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  // Compose the internal timeout signal with an optional caller signal.
  const signals: AbortSignal[] = [timeoutController.signal];
  if (options.signal) signals.push(options.signal);
  const composedSignal =
    signals.length === 1
      ? signals[0]
      : (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal })
          .any?.(signals) ?? signals[0];

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...userHeaders,
          'User-Agent': options.userAgent ?? 'DeepCode',
        },
        signal: composedSignal,
      });
    } catch (e) {
      if (timeoutController.signal.aborted) {
        throw new CloudModelsFetchError(
          `Request to ${url} timed out after ${timeoutMs}ms`,
          undefined,
          e,
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new CloudModelsFetchError(
        `Network error contacting ${url}: ${msg}`,
        undefined,
        e,
      );
    }

    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        // ignore — best effort
      }
      if (response.status === 401 && isOurAuthError(bodyText)) {
        throw new CloudModelsAuthError();
      }
      const snippet = bodyText
        ? bodyText.length > 200
          ? bodyText.slice(0, 200) + '…'
          : bodyText
        : response.statusText || 'no body';
      throw new CloudModelsFetchError(
        `Proxy /web-api/models returned HTTP ${response.status}: ${snippet}`,
        response.status,
      );
    }

    let parsed: WebApiModelsResponse;
    try {
      parsed = (await response.json()) as WebApiModelsResponse;
    } catch (e) {
      throw new CloudModelsFetchError(
        'Proxy /web-api/models returned a body that is not valid JSON',
        response.status,
        e,
      );
    }

    if (!parsed?.success) {
      throw new CloudModelsFetchError(
        parsed?.message || 'Proxy /web-api/models response was unsuccessful',
        response.status,
      );
    }
    if (!Array.isArray(parsed.data)) {
      throw new CloudModelsFetchError(
        'Proxy /web-api/models response is missing the expected "data" array',
        response.status,
      );
    }

    const models: CloudModelInfo[] = parsed.data
      .filter(
        (m): m is WebApiModelInfo & { name: string } =>
          !!m && typeof m.name === 'string',
      )
      .map((m) => ({
        name: m.name,
        displayName:
          typeof m.displayName === 'string' && m.displayName
            ? m.displayName
            : m.name,
        creditsPerRequest:
          typeof m.creditsPerRequest === 'number' ? m.creditsPerRequest : 0,
        available: m.available !== false,
        maxToken: typeof m.maxToken === 'number' ? m.maxToken : 0,
        highVolumeThreshold:
          typeof m.highVolumeThreshold === 'number' ? m.highVolumeThreshold : 0,
        highVolumeCredits:
          typeof m.highVolumeCredits === 'number' ? m.highVolumeCredits : 0,
      }));

    models.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return models;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
