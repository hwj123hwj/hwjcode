/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression test for the VSCode sub-agent model-override bug.
 *
 * Bug: AIService.initialize() built its session `Config` WITHOUT passing
 * `modelOverrides`, so the Config kept an empty `{}` override map and
 * `getSubAgentModelOverride()` always returned undefined — sub-agents (e.g.
 * code-analysis) wrongly inherited the parent session model instead of the
 * Code Expert / Verification model configured in /config. (Same root cause
 * as the CLI Feishu/remote isolated-Config omission.)
 *
 * This test pins the WIRING the fix relies on: the overrides the plugin reads
 * from UserSettingsService must resolve to the correct sub-agent model once
 * injected into a core Config — exactly the value AIService.initialize() now
 * passes as `modelOverrides`, and the value the extension.ts handler hot-reloads
 * via config.setModelOverrides().
 */

import { describe, it, expect, vi } from 'vitest';
import { Config, type ModelOverrides } from 'deepv-code-core';
import { UserSettingsService } from './userSettingsService.js';

const stubLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

/** Build a Config the way AIService.initialize() does for a session. */
function buildSessionConfig(modelOverrides: ModelOverrides | undefined): Config {
  return new Config({
    sessionId: 'vscode-test-session',
    targetDir: process.cwd(),
    cwd: process.cwd(),
    debugMode: false,
    model: 'auto',
    modelOverrides,
  });
}

describe('VSCode AIService — modelOverrides reach sub-agent resolution', () => {
  it('configured codeExpert / verification overrides resolve per sub-agent type', () => {
    const service = UserSettingsService.getInstance(stubLogger);
    vi.spyOn(service, 'getModelOverrides').mockReturnValue({
      codeExpert: 'claude-flash-x',
      verification: 'gemini-2.5-flash',
    });

    // Mirrors AIService.initialize(): read overrides → inject into Config.
    const config = buildSessionConfig(service.getModelOverrides());

    // code-analysis (default sub-agent) → codeExpert; verification → verification.
    expect(config.getSubAgentModelOverride('code-analysis')).toBe('claude-flash-x');
    expect(config.getSubAgentModelOverride('verification')).toBe('gemini-2.5-flash');
  });

  it('with no overrides persisted, sub-agents inherit the session model (undefined)', () => {
    const service = UserSettingsService.getInstance(stubLogger);
    vi.spyOn(service, 'getModelOverrides').mockReturnValue({});

    const config = buildSessionConfig(service.getModelOverrides());

    expect(config.getSubAgentModelOverride('code-analysis')).toBeUndefined();
    expect(config.getSubAgentModelOverride('verification')).toBeUndefined();
  });

  it('hot-reload via setModelOverrides updates an already-built session Config', () => {
    const config = buildSessionConfig({});
    expect(config.getSubAgentModelOverride('code-analysis')).toBeUndefined();

    // Mirrors the extension.ts project-settings-update handler:
    // persist, then push into every live session's Config.
    config.setModelOverrides({ codeExpert: 'claude-sonnet-4' });

    expect(config.getSubAgentModelOverride('code-analysis')).toBe('claude-sonnet-4');
  });
});
