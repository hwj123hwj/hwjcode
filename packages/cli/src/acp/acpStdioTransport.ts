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
 * Redirect all process-wide `console.log/info/warn/debug` output to stderr.
 *
 * ACP speaks JSON-RPC over stdout, so ANY stray `process.stdout.write` from
 * deep inside core or its dependencies (HTTP clients printing "Connecting to
 * ...", compression service debug logs, etc.) corrupts the wire format.
 * Strict clients disconnect on bad frames; lenient ones just pay parser cost.
 *
 * We keep `console.error` untouched because it already goes to stderr.
 *
 * This MUST run before any module that captures `console.log` at import
 * time has been loaded. `runAcpClient` is the earliest ACP-specific entry
 * point in the CLI, called from `gemini.tsx` right after arg parsing, so
 * doing it here is safe.
 */
function redirectConsoleToStderrForAcp(): void {
  const toStderr = (
    prefix: string,
    ...args: unknown[]
  ): void => {
    try {
      const msg = args
        .map((a) =>
          typeof a === 'string' ? a : (() => {
            try { return JSON.stringify(a); } catch { return String(a); }
          })(),
        )
        .join(' ');
      process.stderr.write(`${prefix}${msg}\n`);
    } catch {
      // Swallow — a broken logger must never crash the ACP runtime.
    }
  };

  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => toStderr('', ...args);
  // eslint-disable-next-line no-console
  console.info = (...args: unknown[]) => toStderr('', ...args);
  // eslint-disable-next-line no-console
  console.warn = (...args: unknown[]) => toStderr('', ...args);
  // eslint-disable-next-line no-console
  console.debug = (...args: unknown[]) => toStderr('', ...args);
}

/**
 * Start the ACP agent over stdio.
 *
 * Responsibilities:
 * - Redirect `console.*` to stderr so stray logs don't corrupt JSON-RPC.
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
  redirectConsoleToStderrForAcp();

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
