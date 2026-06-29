/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchCloudModels,
  CloudModelsFetchError,
  CloudModelsAuthError,
} from './cloudModels.js';
import { proxyAuthManager } from './proxyAuth.js';

describe('fetchCloudModels', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(proxyAuthManager, 'getUserHeaders').mockResolvedValue({
      Authorization: 'Bearer tok',
      'User-Agent': 'should-be-overridable',
    });
    vi.spyOn(proxyAuthManager, 'getProxyServerUrl').mockReturnValue(
      'https://proxy.test',
    );
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('GETs /web-api/models and returns normalized, displayName-sorted models', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: [
            { name: 'b-model', displayName: 'Zeta' },
            {
              name: 'a-model',
              displayName: 'Alpha',
              creditsPerRequest: 3,
              available: false,
              maxToken: 100,
              highVolumeThreshold: 50,
              highVolumeCredits: 6,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await fetchCloudModels({ userAgent: 'DeepCode ACP' });

    // Sorted by displayName.
    expect(models.map((m) => m.displayName)).toEqual(['Alpha', 'Zeta']);

    // Missing fields normalized to defaults.
    const zeta = models.find((m) => m.displayName === 'Zeta')!;
    expect(zeta).toMatchObject({
      name: 'b-model',
      displayName: 'Zeta',
      creditsPerRequest: 0,
      available: true,
      maxToken: 0,
      highVolumeThreshold: 0,
      highVolumeCredits: 0,
    });

    // Provided fields preserved, including available:false.
    const alpha = models.find((m) => m.displayName === 'Alpha')!;
    expect(alpha).toMatchObject({
      creditsPerRequest: 3,
      available: false,
      maxToken: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://proxy.test/web-api/models');
    expect((init as RequestInit).method).toBe('GET');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    // The caller-supplied User-Agent wins over the one in proxy headers.
    expect(headers['User-Agent']).toBe('DeepCode ACP');
  });

  it('drops entries without a string name', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: [
            { name: 'ok', displayName: 'OK' },
            { displayName: 'no-name' },
            null,
          ],
        }),
        { status: 200 },
      ),
    );
    const models = await fetchCloudModels();
    expect(models.map((m) => m.name)).toEqual(['ok']);
  });

  it('strips trailing slashes from a custom baseUrl', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
    );
    await fetchCloudModels({ baseUrl: 'https://example.test///' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://example.test/web-api/models',
    );
  });

  it('throws CloudModelsAuthError on 401 with our auth error body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'Unauthorized',
          errorCode: 'AUTHENTICATION_FAILED',
        }),
        { status: 401 },
      ),
    );
    let err: unknown;
    try {
      await fetchCloudModels();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CloudModelsAuthError);
    expect((err as CloudModelsAuthError).status).toBe(401);
  });

  it('throws a generic CloudModelsFetchError on a non-our 401', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'something else' }), { status: 401 }),
    );
    let err: unknown;
    try {
      await fetchCloudModels();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CloudModelsFetchError);
    expect(err).not.toBeInstanceOf(CloudModelsAuthError);
    expect((err as CloudModelsFetchError).status).toBe(401);
  });

  it('throws a generic CloudModelsFetchError on other non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(fetchCloudModels()).rejects.toMatchObject({
      name: 'CloudModelsFetchError',
      status: 500,
    });
  });

  it('throws when the success flag is false', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, message: 'nope' }), {
        status: 200,
      }),
    );
    await expect(fetchCloudModels()).rejects.toBeInstanceOf(
      CloudModelsFetchError,
    );
  });

  it('throws when data is not an array', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }),
    );
    await expect(fetchCloudModels()).rejects.toBeInstanceOf(
      CloudModelsFetchError,
    );
  });

  it('wraps network errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(fetchCloudModels()).rejects.toBeInstanceOf(
      CloudModelsFetchError,
    );
  });

  it('throws without calling fetch when no proxy base url is configured', async () => {
    (proxyAuthManager.getProxyServerUrl as ReturnType<typeof vi.fn>).mockReturnValue(
      '',
    );
    await expect(fetchCloudModels()).rejects.toBeInstanceOf(
      CloudModelsFetchError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
