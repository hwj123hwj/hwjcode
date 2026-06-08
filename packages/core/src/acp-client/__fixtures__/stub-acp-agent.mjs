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
 */

import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const MODE = process.env.STUB_MODE || 'normal';

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

// eslint-disable-next-line no-new
new acp.AgentSideConnection(
  (conn) => ({
    async initialize() {
      return { protocolVersion: acp.PROTOCOL_VERSION };
    },
    async newSession() {
      return { sessionId: 'stub-session-1' };
    },
    async authenticate() {
      return {};
    },
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
          status: 'in_progress',
        },
      });

      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `chose:${chosen}` },
        },
      });

      return { stopReason: 'end_turn' };
    },
    async cancel() {
      // no-op; the client kills the process on cancel
    },
  }),
  stream,
);
