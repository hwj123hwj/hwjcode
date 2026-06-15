/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal ACP *agent* (server) used to test the Easy Code ACP client.
 *
 * Behaviour is selected via the STUB_MODE env var:
 *   - "normal" (default): on prompt, asks for permission, then streams an
 *     agent message echoing which permission option the client selected, plus
 *     a tool_call update, then ends the turn.
 *   - "hang": never resolves the prompt (used for abort/cancel tests).
 *   - "rich": on prompt, additionally emits plan + usage_update so the client
 *     can capture structured progress (used by the structured-status tests).
 *   - "terminal": newSession reports model state, and the prompt emits a Bash
 *     tool whose real output is carried in `_meta.terminal_output.data` plus an
 *     exit code (used by the terminal-output + model-capture tests).
 *   - "setmodel": newSession reports model state (two models), implements
 *     `session/set_model` by recording the requested modelId and echoing it back
 *     in the agent message (used by the set_model integration tests).
 *   - "configmodel": emulates the claude-agent-acp bridge — newSession exposes
 *     models via `configOptions` (id="model"), has NO top-level `models` field,
 *     and rejects `session/set_model` (-32601). Implements
 *     `session/set_config_option` (configId="model") by recording the value and
 *     echoing it back (used by the configOptions model-switch test).
 *   - "replay": on `session/load`, emits an `agent_message_chunk` ("OLD_HISTORY_
 *     REPLAY") before resolving — emulating the real bridge replaying prior
 *     conversation history (used by the resume-watermark regression test).
 *
 * Session discovery/resume RPCs are always available: the stub advertises the
 * `loadSession` and `sessionCapabilities.list` capabilities, answers
 * `session/list` with two fixed sessions, and accepts `session/load`.
 */

import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const MODE = process.env.STUB_MODE || 'normal';

// For STUB_MODE=setmodel: records the last modelId the client requested via
// `session/set_model`, so the prompt can echo it back for the integration test
// to observe.
let lastSetModelId = null;

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

// eslint-disable-next-line no-new
new acp.AgentSideConnection(
  (conn) => ({
    async initialize() {
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {} },
        },
      };
    },
    async newSession() {
      if (MODE === 'terminal') {
        // Advertise model state so the client can capture the model name.
        return {
          sessionId: 'stub-session-1',
          models: {
            currentModelId: 'deepseek-v4-pro',
            availableModels: [
              { modelId: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
              { modelId: 'other', name: 'Other Model' },
            ],
          },
        };
      }
      if (MODE === 'setmodel') {
        // Advertise two models so the client can resolve + switch between them.
        return {
          sessionId: 'stub-session-1',
          models: {
            currentModelId: 'deepseek-v4-pro',
            availableModels: [
              { modelId: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
              { modelId: 'gpt-5-codex', name: 'GPT-5 Codex' },
            ],
          },
        };
      }
      if (MODE === 'configmodel') {
        // No top-level `models`; the model list lives in configOptions, exactly
        // like the real claude-agent-acp bridge.
        return {
          sessionId: 'stub-session-1',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              currentValue: 'default',
              options: [
                { value: 'default', name: 'Default (recommended)' },
                { value: 'sonnet', name: 'Sonnet' },
                { value: 'haiku', name: 'Haiku' },
              ],
            },
          ],
        };
      }
      return { sessionId: 'stub-session-1' };
    },
    async loadSession(params) {
      // For STUB_MODE=replay: emulate the real bridge, which replays the prior
      // conversation as session updates BEFORE resolving session/load. The
      // client must not leak this into the resumed turn's answer/transcript.
      if (MODE === 'replay') {
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'OLD_HISTORY_REPLAY' },
          },
        });
      }
      // Accept the resume; the client then drives prompt() as usual.
      return {};
    },
    async listSessions(params) {
      const all = [
        {
          sessionId: 'sess-newest',
          cwd: params?.cwd ?? '/tmp/project',
          title: 'Newest session',
          updatedAt: '2026-06-01T10:00:00.000Z',
        },
        {
          sessionId: 'sess-older',
          cwd: params?.cwd ?? '/tmp/project',
          title: 'Older session',
          updatedAt: '2026-05-01T10:00:00.000Z',
        },
      ];
      // Honor a single-page cursor so the client's pagination loop terminates.
      return { sessions: all };
    },
    async authenticate() {
      return {};
    },
    // Only advertised/handled in setmodel mode: record the requested modelId so
    // the prompt can echo it back. In other modes this method is absent, so the
    // SDK answers `session/set_model` with a "method not found" error — exactly
    // the bridge-doesn't-support-it path the client must tolerate.
    ...(MODE === 'setmodel'
      ? {
          async unstable_setSessionModel(params) {
            lastSetModelId = params.modelId;
            return {};
          },
        }
      : {}),
    // Only in configmodel mode: the bridge switches models via
    // session/set_config_option (configId="model"), NOT session/set_model.
    // Record the requested value so the prompt can echo it back. Absent in
    // other modes, so set_config_option there yields "method not found".
    ...(MODE === 'configmodel'
      ? {
          async setSessionConfigOption(params) {
            if (params.configId === 'model') lastSetModelId = params.value;
            return {};
          },
        }
      : {}),
    async prompt(params) {
      if (MODE === 'hang') {
        // Never resolve — the client is expected to cancel/kill us.
        await new Promise(() => {});
        return { stopReason: 'end_turn' };
      }

      const perm = await conn.requestPermission({
        sessionId: params.sessionId,
        options: [
          { kind: 'allow_always', name: 'Always Allow', optionId: 'allow' },
          { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
        ],
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Edit src/foo.ts',
          status: 'pending',
        },
      });

      const chosen =
        perm.outcome.outcome === 'selected'
          ? perm.outcome.optionId
          : perm.outcome.outcome;

      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Edit src/foo.ts',
          kind: 'edit',
          status: 'in_progress',
        },
      });

      if (MODE === 'terminal') {
        // Simulate the Claude Code bridge: a Bash tool whose real output is
        // carried out-of-band in `_meta.terminal_output.data` (the inline
        // terminal block only references a terminalId), plus an exit code.
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'term-1',
            title: 'Terminal',
            kind: 'execute',
            status: 'in_progress',
            content: [{ type: 'terminal', terminalId: 'pty-1' }],
          },
        });
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'term-1',
            title: 'Terminal',
            status: 'completed',
            content: [{ type: 'terminal', terminalId: 'pty-1' }],
            _meta: {
              terminal_output: { data: 'hello from bash\nline two\n' },
              terminal_exit: { exit_code: 0 },
            },
          },
        });
      }

      if (MODE === 'rich') {
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [
              { content: 'Step one', status: 'completed', priority: 'high' },
              { content: 'Step two', status: 'in_progress', priority: 'medium' },
              { content: 'Step three', status: 'pending', priority: 'low' },
            ],
          },
        });
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'usage_update', used: 1234, size: 10000 },
        });
      }

      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `chose:${chosen}` },
        },
      });

      if (MODE === 'setmodel' || MODE === 'configmodel') {
        // Echo whatever modelId the client set (or "none" if it never switched),
        // so the integration test can assert on it.
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ` setmodel:${lastSetModelId ?? 'none'}` },
          },
        });
      }

      return { stopReason: 'end_turn' };
    },
    async cancel() {
      // no-op; the client kills the process on cancel
    },
  }),
  stream,
);
