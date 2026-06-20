/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchOpenAICompatibleModels,
  OpenAIModelFetchError,
} from './openAICompatibleClient.js';

describe('fetchOpenAICompatibleModels', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('sends GET to {baseUrl}/models with Bearer auth, parses OpenAI data format', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-4-turbo' },
            { id: 'gpt-4o' },
            { id: 'deepv-deepseek-pro' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const models = await fetchOpenAICompatibleModels(
      'http://localhost:4001/v1',
      'sk-test',
    );
    expect(models.map((m) => m.id)).toEqual([
      'gpt-4-turbo',
      'gpt-4o',
      'deepv-deepseek-pro',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4001/v1/models');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer sk-test',
    });
  });

  it('parses custom gateway format with "models" field', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'list',
          models: [
            { id: 'deepv-deepseek-pro' },
            { id: 'glm-sonnet' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const models = await fetchOpenAICompatibleModels(
      'https://api.example.com',
      'key-123',
    );
    expect(models.map((m) => m.id)).toEqual(['deepv-deepseek-pro', 'glm-sonnet']);
  });

  it('strips trailing slash from baseUrl before appending /models', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await fetchOpenAICompatibleModels('http://localhost:4001/v1/', 'sk-test');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4001/v1/models');
  });

  it('filters out entries without id or with empty id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: 'valid-model' },
            { name: 'no-id' },
            { id: '' },
            { id: '  ' },
            { id: 'another-valid' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const models = await fetchOpenAICompatibleModels(
      'http://localhost:4001/v1',
      'sk-test',
    );
    expect(models.map((m) => m.id)).toEqual(['valid-model', 'another-valid']);
  });

  it('throws OpenAIModelFetchError on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    await expect(
      fetchOpenAICompatibleModels('http://localhost:4001/v1', 'bad-key'),
    ).rejects.toBeInstanceOf(OpenAIModelFetchError);

    // Second call needs its own mock resolution.
    fetchMock.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );
    await expect(
      fetchOpenAICompatibleModels('http://localhost:4001/v1', 'bad-key'),
    ).rejects.toMatchObject({ message: 'Server returned HTTP 401' });
  });

  it('throws OpenAIModelFetchError when response has no usable model IDs', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      fetchOpenAICompatibleModels('http://localhost:4001/v1', 'sk-test'),
    ).rejects.toBeInstanceOf(OpenAIModelFetchError);
  });

  it('throws OpenAIModelFetchError on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      fetchOpenAICompatibleModels('http://localhost:9999/v1', 'sk-test'),
    ).rejects.toBeInstanceOf(OpenAIModelFetchError);
  });
});
