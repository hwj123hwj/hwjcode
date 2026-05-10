/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Config, createWorkingStdio } from 'deepv-code-core';
import { runExitCleanup } from '../utils/cleanup.js';
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import type { LoadedSettings } from '../config/settings.js';
import type { CliArgs } from '../config/config.js';
import { GeminiAgent } from './acpRpcDispatcher.js';

/**
 * Start the ACP agent over stdio.
 *
 * Responsibilities:
 * - Capture the "working" stdout (`createWorkingStdio`) so that ink or other
 *   writers that may monkey-patch `process.stdout.write` can't corrupt the
 *   JSON-RPC frames we send.
 * - Convert the Node streams to Web streams for the ACP SDK.
 * - Create the ndjson frame stream and the {@link acp.AgentSideConnection}.
 * - Block on `connection.closed` until the client disconnects, then run the
 *   normal process cleanup (telemetry flush, tmp dir cleanup, etc.).
 */
export async function runAcpClient(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
): Promise<void> {
  const { stdout: workingStdout } = createWorkingStdio();
  const stdout = Writable.toWeb(workingStdout) as WritableStream;
  const stdin = Readable.toWeb(process.stdin) as unknown as ReadableStream<
    Uint8Array
  >;

  const stream = acp.ndJsonStream(stdout, stdin);
  const connection = new acp.AgentSideConnection(
    (conn) => new GeminiAgent(config, settings, argv, conn),
    stream,
  );

  // SIGTERM/SIGINT handlers inside the SDK don't fire when stdin simply
  // closes, so we explicitly await the connection close and then flush
  // exit-time cleanup (telemetry, tmp dir, etc.). `finally()` ensures
  // cleanup runs even if the stream faulted.
  await connection.closed.finally(runExitCleanup);
}
