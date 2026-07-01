/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import type { Config, ModelOverrides } from 'deepv-code-core';
import { RemoteSession } from './remoteSession.js';

/**
 * 回归测试：远程/网关隔离会话必须继承父会话的 modelOverrides。
 *
 * Bug：buildIsolatedConfig 之前未把 sharedConfig 的 modelOverrides 透传给隔离 Config，
 * 导致隔离 Config 的 modelOverrides 为空对象，getSubAgentModelOverride() 永远返回
 * undefined，子 agent（如 code-analysis）错误地继承父会话模型，而不是 /config 中
 * 为 Code Expert / Verification 配置的专属模型。TUI 模式不受影响，因为它经由
 * loadCliConfig 把 settings.modelOverrides 注入 Config。
 */

function createMockWebSocket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: () => {},
  } as unknown as WebSocket;
}

// 反射调用 private 方法
async function invokePrivate<T = unknown>(
  target: unknown,
  method: string,
  ...args: unknown[]
): Promise<T> {
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== 'function') {
    throw new Error(`private method not found: ${method}`);
  }
  return (fn as (...a: unknown[]) => Promise<T>).apply(target, args);
}

function createSharedConfig(overrides: ModelOverrides): Config {
  return {
    getDebugMode: () => false,
    getModel: () => 'auto',
    getCustomModels: () => [],
    getCloudModels: () => [],
    getProxy: () => undefined,
    getCustomProxyServerUrl: () => undefined,
    getMcpServers: () => ({}),
    getModelOverrides: () => overrides,
  } as unknown as Config;
}

describe('RemoteSession.buildIsolatedConfig modelOverrides 透传', () => {
  it('把父会话的 modelOverrides 注入隔离 Config，使子代理模型覆盖生效', async () => {
    const overrides: ModelOverrides = {
      codeExpert: 'claude-flash-x',
      verification: 'gemini-2.5-flash',
    };
    const session = new RemoteSession(
      createMockWebSocket(),
      createSharedConfig(overrides),
      'test-session',
    );

    const isolated = await invokePrivate<Config>(
      session,
      'buildIsolatedConfig',
      process.cwd(),
    );

    expect(isolated.getModelOverrides()).toEqual(overrides);
    // code-analysis → codeExpert，verification → verification
    expect(isolated.getSubAgentModelOverride('code-analysis')).toBe(
      'claude-flash-x',
    );
    expect(isolated.getSubAgentModelOverride('verification')).toBe(
      'gemini-2.5-flash',
    );
  });

  it('父会话未配置覆盖时，隔离 Config 的子代理覆盖为 undefined（继承父模型）', async () => {
    const session = new RemoteSession(
      createMockWebSocket(),
      createSharedConfig({}),
      'test-session',
    );

    const isolated = await invokePrivate<Config>(
      session,
      'buildIsolatedConfig',
      process.cwd(),
    );

    expect(isolated.getSubAgentModelOverride('code-analysis')).toBeUndefined();
    expect(isolated.getSubAgentModelOverride('verification')).toBeUndefined();
  });
});
