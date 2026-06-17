/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectLocalAgents,
  isAgentAvailable,
  hasAnyLocalAgent,
} from './localAgentDetection.js';

describe('localAgentDetection', () => {
  describe('detectLocalAgents', () => {
    it('returns both false when neither binary is found', async () => {
      const result = await detectLocalAgents({
        lookup: async () => false,
      });
      expect(result.claudeCode).toBe(false);
      expect(result.codex).toBe(false);
    });

    it('returns claudeCode=true when claude is on PATH', async () => {
      const result = await detectLocalAgents({
        lookup: async (bin) => bin === 'claude',
      });
      expect(result.claudeCode).toBe(true);
      expect(result.codex).toBe(false);
    });

    it('returns codex=true when codex is on PATH', async () => {
      const result = await detectLocalAgents({
        lookup: async (bin) => bin === 'codex',
      });
      expect(result.claudeCode).toBe(false);
      expect(result.codex).toBe(true);
    });

    it('returns both true when both are on PATH', async () => {
      const result = await detectLocalAgents({
        lookup: async () => true,
      });
      expect(result.claudeCode).toBe(true);
      expect(result.codex).toBe(true);
    });

    it('treats override env var as available even if binary is missing', async () => {
      const result = await detectLocalAgents({
        lookup: async () => false,
        env: { EASYCODE_CLAUDE_CODE_ACP_CMD: 'node /custom/bridge.js' },
      });
      expect(result.claudeCode).toBe(true);
      expect(result.codex).toBe(false);
    });

    it('treats codex override env var as available', async () => {
      const result = await detectLocalAgents({
        lookup: async () => false,
        env: { EASYCODE_CODEX_ACP_CMD: 'node /custom/codex-bridge.js' },
      });
      expect(result.claudeCode).toBe(false);
      expect(result.codex).toBe(true);
    });

    it('never throws — lookup errors resolve to false', async () => {
      const result = await detectLocalAgents({
        lookup: async () => {
          throw new Error('boom');
        },
      });
      expect(result.claudeCode).toBe(false);
      expect(result.codex).toBe(false);
    });

    it('empty/whitespace override env var does NOT count as available', async () => {
      const result = await detectLocalAgents({
        lookup: async () => false,
        env: { EASYCODE_CLAUDE_CODE_ACP_CMD: '   ' },
      });
      expect(result.claudeCode).toBe(false);
    });
  });

  describe('isAgentAvailable', () => {
    it('returns true when the binary is found', async () => {
      expect(
        await isAgentAvailable('claude-code', async (b) => b === 'claude'),
      ).toBe(true);
    });

    it('returns false when the binary is not found', async () => {
      expect(
        await isAgentAvailable('codex', async () => false),
      ).toBe(false);
    });

    it('returns true when override env is set', async () => {
      expect(
        await isAgentAvailable(
          'claude-code',
          async () => false,
          { EASYCODE_CLAUDE_CODE_ACP_CMD: 'custom-bridge' },
        ),
      ).toBe(true);
    });
  });

  describe('hasAnyLocalAgent', () => {
    it('returns false when neither is available', async () => {
      expect(
        await hasAnyLocalAgent({ lookup: async () => false }),
      ).toBe(false);
    });

    it('returns true when only claude-code is available', async () => {
      expect(
        await hasAnyLocalAgent({
          lookup: async (b) => b === 'claude',
        }),
      ).toBe(true);
    });

    it('returns true when only codex is available', async () => {
      expect(
        await hasAnyLocalAgent({
          lookup: async (b) => b === 'codex',
        }),
      ).toBe(true);
    });
  });
});
