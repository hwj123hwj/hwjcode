/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Kind, ApprovalMode, proxyAuthManager } from 'deepv-code-core';
import type { Config } from 'deepv-code-core';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { SettingScope } from '../config/settings.js';
import {
  buildAvailableModes,
  buildUsageUpdate,
  hasMeta,
  refreshCloudModelsForAcp,
  toAcpToolKind,
} from './acpUtils.js';

describe('hasMeta', () => {
  it('detects objects with a `_meta` property', () => {
    expect(hasMeta({ _meta: {} })).toBe(true);
  });
  it('returns false for plain objects', () => {
    expect(hasMeta({})).toBe(false);
    expect(hasMeta(null)).toBe(false);
    expect(hasMeta('x')).toBe(false);
  });
});

describe('toAcpToolKind', () => {
  it('passes through known kinds', () => {
    expect(toAcpToolKind(Kind.Read)).toBe('read');
    expect(toAcpToolKind(Kind.Edit)).toBe('edit');
    expect(toAcpToolKind(Kind.Execute)).toBe('execute');
    expect(toAcpToolKind(Kind.Fetch)).toBe('fetch');
  });

  it('collapses non-ACP kinds to `other`', () => {
    expect(toAcpToolKind(Kind.Plan)).toBe('other');
    expect(toAcpToolKind(Kind.Communicate)).toBe('other');
    expect(toAcpToolKind(Kind.SwitchMode)).toBe('other');
  });

  it('maps the Agent kind to `think`', () => {
    expect(toAcpToolKind(Kind.Agent)).toBe('think');
  });
});

describe('buildAvailableModes', () => {
  it('includes the three DeepCode approval modes', () => {
    const modes = buildAvailableModes();
    const ids = modes.map((m) => m.id);
    expect(ids).toContain(ApprovalMode.DEFAULT);
    expect(ids).toContain(ApprovalMode.AUTO_EDIT);
    expect(ids).toContain(ApprovalMode.YOLO);
  });

  it('ignores the isPlanEnabled flag (DeepCode has no Plan mode)', () => {
    const defaultModes = buildAvailableModes(false);
    const planModes = buildAvailableModes(true);
    expect(planModes.length).toBe(defaultModes.length);
  });
});

describe('buildUsageUpdate', () => {
  // Minimal Config stub: `tokenLimit()` only reads `getCloudModelInfo`,
  // and `buildUsageUpdate` reads `getModel`. Anything else is fine to
  // leave as `undefined` for these unit tests.
  const fakeConfig = {
    getModel: () => 'auto',
    getCloudModelInfo: (name: string) =>
      name === 'auto' ? { maxToken: 200000 } : undefined,
  } as unknown as Config;

  it('returns null when usageMetadata is missing', () => {
    expect(buildUsageUpdate(undefined, fakeConfig)).toBeNull();
  });

  it('returns null when no tokens were spent', () => {
    expect(
      buildUsageUpdate(
        { totalTokenCount: 0 } as GenerateContentResponseUsageMetadata,
        fakeConfig,
      ),
    ).toBeNull();
  });

  it('emits a `usage_update` with the model token limit', () => {
    const update = buildUsageUpdate(
      { totalTokenCount: 1234 } as GenerateContentResponseUsageMetadata,
      fakeConfig,
    );
    expect(update).toEqual({
      sessionUpdate: 'usage_update',
      used: 1234,
      size: 200000,
    });
  });

  it('falls back to prompt+candidates when totalTokenCount is absent', () => {
    const update = buildUsageUpdate(
      {
        promptTokenCount: 800,
        candidatesTokenCount: 200,
      } as GenerateContentResponseUsageMetadata,
      fakeConfig,
    );
    expect(update).toMatchObject({
      sessionUpdate: 'usage_update',
      used: 1000,
    });
  });
});

describe('refreshCloudModelsForAcp', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  // Minimal Config stub exposing only the cloud-model accessors the function
  // touches. `setCloudModels` doubles as the in-memory store for getCloudModels.
  let config: {
    _cloud: unknown[];
    getCloudModels: () => unknown[];
    setCloudModels: ReturnType<typeof vi.fn>;
  };
  let settings: { setValue: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(proxyAuthManager, 'getUserHeaders').mockResolvedValue({
      Authorization: 'Bearer tok',
    });
    vi.spyOn(proxyAuthManager, 'getProxyServerUrl').mockReturnValue(
      'https://proxy.test',
    );
    const store: { _cloud: unknown[] } = { _cloud: [] };
    config = {
      _cloud: store._cloud,
      getCloudModels: () => store._cloud,
      setCloudModels: vi.fn((m: unknown[]) => {
        store._cloud = m;
      }),
    };
    settings = { setValue: vi.fn() };
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('fetches, seeds Config, and persists the list to user settings', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: [{ name: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' }],
        }),
        { status: 200 },
      ),
    );

    await refreshCloudModelsForAcp(
      config as unknown as Config,
      settings as never,
    );

    expect(config.setCloudModels).toHaveBeenCalledTimes(1);
    const seeded = config.setCloudModels.mock.calls[0][0] as unknown[];
    expect(seeded).toEqual([
      expect.objectContaining({
        name: 'claude-sonnet-4-6',
        displayName: 'Sonnet 4.6',
        available: true,
      }),
    ]);
    // Same normalized list is written through to the user settings.json cache,
    // so the next cold start (desktop-only user) is warm.
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'cloudModels',
      seeded,
    );
  });

  it('is best-effort: never throws and skips seeding when the fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    await expect(
      refreshCloudModelsForAcp(config as unknown as Config, settings as never),
    ).resolves.toBeUndefined();

    expect(config.setCloudModels).not.toHaveBeenCalled();
    expect(settings.setValue).not.toHaveBeenCalled();
  });

  it('still seeds Config when no settings are provided', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, data: [{ name: 'm', displayName: 'M' }] }),
        { status: 200 },
      ),
    );

    await refreshCloudModelsForAcp(config as unknown as Config);

    expect(config.setCloudModels).toHaveBeenCalledTimes(1);
  });
});
