/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight client that fetches available model IDs from an OpenAI-compatible
 * `/v1/models` (or `/models`) endpoint. Used by the CustomModelWizard to
 * auto-discover models instead of requiring manual model-ID entry.
 */

export interface OpenAIModelEntry {
  id: string;
}

export class OpenAIModelFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenAIModelFetchError';
  }
}

/**
 * Hit `GET {baseUrl}/models` with a Bearer token and parse the response.
 *
 * Supports the standard OpenAI format `{ data: [{ id }] }` as well as
 * custom gateway formats that return `{ models: [{ id }] }` on the wire.
 *
 * @param baseUrl - Base URL (e.g. `http://localhost:4001/v1`). Trailing
 *   slashes are stripped before appending `/models`.
 * @param apiKey  - Bearer token sent in the `Authorization` header.
 * @param timeoutMs - AbortSignal timeout in ms (default 10 s).
 * @returns Non-empty list of model IDs. Throws on network errors or non-2xx.
 */
export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<OpenAIModelEntry[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as any)?.name === 'TimeoutError' || msg.includes('timeout')) {
      throw new OpenAIModelFetchError(
        `Request to ${url} timed out after ${timeoutMs / 1000}s`,
      );
    }
    throw new OpenAIModelFetchError(
      `Failed to reach ${url}: ${msg}`,
    );
  }

  if (!response.ok) {
    throw new OpenAIModelFetchError(
      `Server returned HTTP ${response.status}`,
      response.status,
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new OpenAIModelFetchError('Response is not valid JSON');
  }

  // OpenAI-compatible format:  { data: [{ id, ... }] }
  // Custom gateway variants:   { models: [{ id, ... }] }
  const rawModels: any[] = data?.data || data?.models || [];

  const entries: OpenAIModelEntry[] = [];
  for (const m of rawModels) {
    if (m && typeof m.id === 'string' && m.id.trim()) {
      entries.push({ id: m.id.trim() });
    }
  }

  if (entries.length === 0) {
    throw new OpenAIModelFetchError('No usable model IDs found in response');
  }

  return entries;
}
