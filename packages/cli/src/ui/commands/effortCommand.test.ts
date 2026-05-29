/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { effortCommand } from './effortCommand.js';
import { CommandContext } from './types.js';
import { SettingScope } from '../../config/settings.js';

// Mock i18n
vi.mock('../utils/i18n.js', () => ({
  t: (key: string) => key,
  tp: (key: string, args: any) => `${key}:${JSON.stringify(args)}`,
}));

interface MockServices {
  settings: { setValue: ReturnType<typeof vi.fn> };
  config: {
    getThinkingConfig: ReturnType<typeof vi.fn>;
    setThinkingConfig: ReturnType<typeof vi.fn>;
  };
}

const buildContext = (currentThinking: any): { context: CommandContext; services: MockServices } => {
  const services: MockServices = {
    settings: { setValue: vi.fn() },
    config: {
      getThinkingConfig: vi.fn().mockReturnValue(currentThinking),
      setThinkingConfig: vi.fn(),
    },
  };
  const context = { services } as unknown as CommandContext;
  return { context, services };
};

describe('effortCommand', () => {
  it('should return dialog effort-wizard if no arguments are provided', async () => {
    const { context } = buildContext({ mode: 'auto', effort: 'auto' });
    const result = await effortCommand.action!(context, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'effort-wizard',
    });
  });

  it('should directly set valid effort levels and update config/settings', async () => {
    const { context, services } = buildContext({ mode: 'auto', effort: 'auto' });
    const result = await effortCommand.action!(context, 'ultracode');

    expect(services.config.setThinkingConfig).toHaveBeenCalledWith({
      mode: 'on',
      effort: 'ultracode',
    });
    expect(services.settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'thinking',
      { mode: 'on', effort: 'ultracode' },
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration',
    });
  });

  it('should return error message for invalid effort levels', async () => {
    const { context } = buildContext({ mode: 'auto', effort: 'auto' });
    const result = await effortCommand.action!(context, 'invalid_level');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Invalid effort level'),
    });
  });
});
