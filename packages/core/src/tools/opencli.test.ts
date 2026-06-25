/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCliTool, OpenCliParams } from './opencli.js';
import { Config } from '../config/config.js';
import { ToolConfirmationOutcome, ToolExecuteConfirmationDetails } from './tools.js';
import { spawn } from 'node:child_process';

// Mock child_process. We stream output through spawn (3-arg array form) and
// probe the global install via spawnSync (`npm root -g`).
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

/**
 * A controllable fake child process for driving spawn-based streaming tests.
 * Tests push data through `emitStdout` / `emitStderr` and finish the process
 * with `close(code)` to simulate real-time output and exit semantics.
 */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killed = false;
  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
  unref = vi.fn();

  emitStdout(chunk: string) {
    this.stdout.emit('data', Buffer.from(chunk));
  }

  emitStderr(chunk: string) {
    this.stderr.emit('data', Buffer.from(chunk));
  }

  /** Simulate the process exiting with the given code. */
  close(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

/** Helper: queue the next FakeChildProcess that spawn() will return. */
function nextChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

/**
 * Asserts the child process was terminated. Cross-platform: on Windows the
 * implementation shells out to `taskkill` (a fresh spawn call) rather than
 * calling child.kill(); on POSIX it calls child.kill('SIGTERM').
 */
function expectChildKilled(child: FakeChildProcess) {
  const taskkillSpawned = mockSpawn.mock.calls.some(
    (call) => call[0] === 'taskkill',
  );
  expect(child.kill.mock.calls.length > 0 || taskkillSpawned).toBe(true);
}

/** The argv array (2nd positional) passed to the i-th spawn call. */
function spawnArgs(i: number): string[] {
  return mockSpawn.mock.calls[i][1] as string[];
}

/** The options object (3rd positional) passed to the i-th spawn call. */
function spawnOpts(i: number): { shell?: boolean } {
  return mockSpawn.mock.calls[i][2] as { shell?: boolean };
}

describe('OpenCliTool', () => {
  let mockConfig: Config;
  let tool: OpenCliTool;

  beforeEach(async () => {
    mockConfig = {} as unknown as Config;
    tool = new OpenCliTool(mockConfig);
    vi.clearAllMocks();
    // Skip the daemon preflight for the general suites; a dedicated describe
    // block exercises it. This env flag also doubles as an automation escape
    // hatch in production.
    process.env.OPENCLI_SKIP_PREFLIGHT = '1';
    process.env.OPENCLI_SKIP_AUTOSTART = '1';
    delete process.env.OPENCLI_ENTRY;
    // Default: opencli binary is found on PATH (probe status 0 for where/which check),
    // but no global npm root entry. This matches standard cli expectations.
    const { spawnSync } = (await import('node:child_process')) as unknown as {
      spawnSync: ReturnType<typeof vi.fn>;
    };
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'where' || cmd === 'which') {
        return { status: 0 };
      }
      return { status: 1, error: new Error('not found') };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OPENCLI_SKIP_PREFLIGHT;
    delete process.env.OPENCLI_SKIP_AUTOSTART;
    delete process.env.OPENCLI_ENTRY;
    delete process.env.OPENCLI_USE_NPX;
  });

  describe('Initialization', () => {
    it('should initialize with correct name and schema', () => {
      expect(tool.name).toBe('opencli');
      expect(tool.displayName).toBe('OpenCLI');
      expect(tool.schema.name).toBe('opencli');
      expect(tool.schema.parameters?.properties?.args).toBeDefined();
    });

    it('should stream live output', () => {
      expect(tool.canUpdateOutput).toBe(true);
    });
  });

  describe('validateToolParams', () => {
    it('should pass on a valid argv array', () => {
      const params: OpenCliParams = {
        args: ['browser', 'work', 'open', 'https://example.com'],
      };
      expect(tool.validateToolParams(params)).toBeNull();
    });

    it('should fail on a missing/empty args array', () => {
      expect(tool.validateToolParams({ args: [] } as OpenCliParams)).toContain(
        'non-empty',
      );
    });

    it('should fail when args is not an array', () => {
      const bad = { args: 'browser work state' } as unknown as OpenCliParams;
      expect(tool.validateToolParams(bad)).toContain('array');
    });

    it('should fail when an arg element is not a string', () => {
      const bad = { args: ['browser', 3] } as unknown as OpenCliParams;
      expect(tool.validateToolParams(bad)).toContain('string');
    });

    it('should fail on an out-of-range timeout', () => {
      const bad = {
        args: ['doctor'],
        timeout: 9999,
      } as OpenCliParams;
      expect(tool.validateToolParams(bad)).toContain('timeout');
    });
  });

  describe('execute - argv construction (shell:false + array, no quoting)', () => {
    it('should pass args as a verbatim argv array to the opencli binary fallback', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['doctor'] },
        new AbortController().signal,
      );
      child.emitStdout('All good');
      child.close(0);
      await promise;

      expect(mockSpawn.mock.calls[0][0]).toBe('opencli');
      expect(spawnArgs(0)).toEqual(['doctor']);
    });

    it('should NOT concatenate or quote args containing spaces', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'type', '4', 'hello world & friends'] },
        new AbortController().signal,
      );
      child.emitStdout('{"typed": true}');
      child.close(0);
      await promise;

      // The text with spaces/specials must survive as a single argv element,
      // never hand-rolled into a quoted shell string.
      expect(spawnArgs(0)).toEqual([
        'browser',
        'work',
        'type',
        '4',
        'hello world & friends',
      ]);
    });

    it('should run node against the resolved entry with shell:false when available', async () => {
      // Point OPENCLI_ENTRY at a real file so the node+entry path is taken.
      process.env.OPENCLI_ENTRY = __filename;
      const localTool = new OpenCliTool(mockConfig);

      const child = nextChild();
      const promise = localTool.execute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );
      child.emitStdout('{}');
      child.close(0);
      await promise;

      expect(mockSpawn.mock.calls[0][0]).toBe(process.execPath);
      expect(spawnArgs(0)).toEqual([__filename, 'browser', 'work', 'state']);
      expect(spawnOpts(0).shell).toBe(false);
    });

    it('should NOT auto-inject --format json', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );
      child.close(0);
      await promise;
      expect(spawnArgs(0)).not.toContain('--format');
    });
  });

  describe('shouldConfirmExecute - read passes, write confirms', () => {
    it('should NOT confirm read-only browser inspection (state)', async () => {
      const res = await tool.shouldConfirmExecute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );
      expect(res).toBe(false);
    });

    it('should NOT confirm read-only get / find / network / eval', async () => {
      for (const verb of [
        ['browser', 'work', 'get', 'value', '4'],
        ['browser', 'work', 'find', '--css', 'a'],
        ['browser', 'work', 'network'],
        ['browser', 'work', 'eval', '1+1'],
        ['doctor'],
      ]) {
        const res = await tool.shouldConfirmExecute(
          { args: verb },
          new AbortController().signal,
        );
        expect(res).toBe(false);
      }
    });

    it('should confirm a browser write (click)', async () => {
      const res = (await tool.shouldConfirmExecute(
        { args: ['browser', 'work', 'click', '6'] },
        new AbortController().signal,
      )) as ToolExecuteConfirmationDetails;
      expect(res).not.toBe(false);
      expect(res.type).toBe('exec');
      expect(res.command).toContain('opencli browser work click 6');
    });

    it('should whitelist a write verb after ProceedAlways', async () => {
      const first = (await tool.shouldConfirmExecute(
        { args: ['browser', 'work', 'type', '4', 'hi'] },
        new AbortController().signal,
      )) as ToolExecuteConfirmationDetails;
      expect(first).not.toBe(false);
      await first.onConfirm(ToolConfirmationOutcome.ProceedAlways);

      const second = await tool.shouldConfirmExecute(
        { args: ['browser', 'work', 'type', '4', 'again'] },
        new AbortController().signal,
      );
      expect(second).toBe(false);
    });

    it('should confirm unknown (site adapter) commands by default (fail-closed)', async () => {
      const res = await tool.shouldConfirmExecute(
        { args: ['facebook', 'post', '--text', 'hi'] },
        new AbortController().signal,
      );
      expect(res).not.toBe(false);
    });

    it('should NOT confirm a `<site> --help` discovery query', async () => {
      for (const help of [
        ['--help'],
        ['github', '--help'],
        ['github', 'issues', '--help'],
        ['facebook', '-h'],
      ]) {
        const res = await tool.shouldConfirmExecute(
          { args: help },
          new AbortController().signal,
        );
        expect(res).toBe(false);
      }
    });
  });

  describe('execute - live streaming + success', () => {
    it('should stream output as data arrives', async () => {
      const updates: string[] = [];
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'open', 'https://x.com'] },
        new AbortController().signal,
        (out) => updates.push(out),
      );
      child.emitStdout('navigating...\n');
      await new Promise((r) => setTimeout(r, 5));
      child.close(0);
      await promise;
      expect(updates.join('')).toContain('navigating');
    });

    it('should parse JSON envelope on success', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );
      child.emitStdout('{"url":"https://x.com","matches_n":1}');
      child.close(0);
      const result = await promise;
      expect(result.status).toBe('success');
      expect(result.data).toEqual({ url: 'https://x.com', matches_n: 1 });
    });
  });

  describe('execute - error classification', () => {
    it('should classify daemon-not-running (BROWSER_CONNECT on stderr)', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );
      child.emitStderr(
        'Cannot connect to opencli daemon.\nHint: Run `opencli doctor` to diagnose, or `opencli daemon restart`.',
      );
      child.close(69);
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.errorKind).toBe('daemon-not-running');
      expect(result.returnDisplay).toContain('opencli doctor');
    });

    it('should classify extension-not-connected', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );
      child.emitStderr('Browser Bridge extension is not connected.');
      child.close(69);
      const result = await promise;
      expect(result.errorKind).toBe('extension-not-connected');
    });

    it('should classify stale_ref (JSON error envelope on stdout)', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'click', '3'] },
        new AbortController().signal,
      );
      child.emitStdout(
        JSON.stringify({
          error: { code: 'stale_ref', message: 'ref changed identity' },
        }),
      );
      child.close(1);
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.errorKind).toBe('stale-ref');
      expect(result.returnDisplay.toLowerCase()).toContain('state');
    });

    it('should classify CDP detach as a transient/retryable error', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'click', '3'] },
        new AbortController().signal,
      );
      child.emitStderr('Detached while handling command');
      child.close(1);
      const result = await promise;
      expect(result.errorKind).toBe('cdp-detached');
    });

    it('should classify not-logged-in as auth_required', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['facebook', 'notifications', '--format', 'json'] },
        new AbortController().signal,
      );
      child.emitStderr(
        'ok: false\nerror:\n  code: AUTH_REQUIRED\n  message: Not logged in to facebook.com\n  exitCode: 77\n',
      );
      child.close(77);
      const result = await promise;
      expect(result.status).toBe('auth_required');
      expect(result.errorKind).toBe('not-logged-in');
    });

    it('should classify timeout exit code', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'wait', 'selector', '.x'] },
        new AbortController().signal,
      );
      child.emitStderr('wait timed out after 10s');
      child.close(75);
      const result = await promise;
      expect(result.errorKind).toBe('timeout');
    });
  });

  describe('execute - timeout watchdog', () => {
    it('should kill the process and fail after the per-command timeout', async () => {
      vi.useFakeTimers();
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'state'], timeout: 30 },
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(30 * 1000 + 500);
      expectChildKilled(child);
      child.close(null, 'SIGTERM');
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.errorKind).toBe('timeout');
    });
  });

  describe('execute - abort', () => {
    it('should kill the process when aborted', async () => {
      const controller = new AbortController();
      const child = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'state'] },
        controller.signal,
      );
      controller.abort();
      await new Promise((r) => setTimeout(r, 5));
      expectChildKilled(child);
      child.close(null, 'SIGTERM');
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.errorKind).toBe('aborted');
    });
  });

  describe('preflight - daemon health check', () => {
    beforeEach(() => {
      delete process.env.OPENCLI_SKIP_PREFLIGHT;
    });

    it('should short-circuit a browser command when the daemon is not running', async () => {
      // 1st spawn = preflight `daemon status`.
      const preflight = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );
      preflight.emitStdout('Daemon: not running');
      preflight.close(0);
      const result = await promise;

      // Only the preflight ran; the real command was never spawned.
      expect(mockSpawn.mock.calls.length).toBe(1);
      expect(spawnArgs(0)).toEqual(['daemon', 'status']);
      expect(result.status).toBe('failed');
      expect(result.errorKind).toBe('daemon-not-running');
    });

    it('should short-circuit when the extension is disconnected', async () => {
      const preflight = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );
      preflight.emitStdout('Daemon: running (PID 1)\nExtension: disconnected');
      preflight.close(0);
      const result = await promise;
      expect(mockSpawn.mock.calls.length).toBe(1);
      expect(result.errorKind).toBe('extension-not-connected');
    });

    it('should proceed to the real command when daemon+extension are ready', async () => {
      const preflight = nextChild();
      const main = nextChild();
      const promise = tool.execute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );
      preflight.emitStdout(
        'Daemon: running (PID 1)\nExtension: connected (v1.0.9)',
      );
      preflight.close(0);
      await new Promise((r) => setTimeout(r, 5));
      main.emitStdout('{"url":"https://x.com"}');
      main.close(0);
      const result = await promise;
      expect(mockSpawn.mock.calls.length).toBe(2);
      expect(spawnArgs(1)).toEqual(['browser', 'work', 'state']);
      expect(result.status).toBe('success');
    });

    it('should NOT preflight infra commands (doctor)', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['doctor'] },
        new AbortController().signal,
      );
      child.emitStdout('ok');
      child.close(0);
      await promise;
      // No preflight: the only spawn is the doctor command itself.
      expect(mockSpawn.mock.calls.length).toBe(1);
      expect(spawnArgs(0)).toEqual(['doctor']);
    });

    it('should NOT preflight a `<site> --help` discovery query', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['github', '--help'] },
        new AbortController().signal,
      );
      child.emitStdout('Usage: opencli github <command>');
      child.close(0);
      await promise;
      // No daemon status probe: the only spawn is the help command itself.
      expect(mockSpawn.mock.calls.length).toBe(1);
      expect(spawnArgs(0)).toEqual(['github', '--help']);
    });

    it('should automatically start daemon when not running and OPENCLI_SKIP_AUTOSTART is not set', async () => {
      delete process.env.OPENCLI_SKIP_AUTOSTART;

      const statusCheck1 = nextChild();
      const daemonStart = nextChild();
      const statusCheck2 = nextChild();
      const realCommand = nextChild();

      const promise = tool.execute(
        { args: ['browser', 'work', 'state'] },
        new AbortController().signal,
      );

      // 1st status check: returns "not running"
      statusCheck1.emitStdout('Daemon: not running');
      statusCheck1.close(0);

      // Let the 1ms test-delay in the tool expire and trigger the auto-start spawn
      await new Promise((r) => setTimeout(r, 10));

      // 2nd spawn: daemon restart runs
      daemonStart.close(0);

      // Let the second status check re-probe run
      await new Promise((r) => setTimeout(r, 10));

      // 3rd spawn: second status check re-probe status
      statusCheck2.emitStdout('Daemon: running (PID 42)\nExtension: connected (v1.0.0)');
      statusCheck2.close(0);

      await new Promise((r) => setTimeout(r, 10));

      // 4th spawn: real command proceeds
      realCommand.emitStdout('{"url":"https://example.com"}');
      realCommand.close(0);

      const result = await promise;
      expect(result.status).toBe('success');
      expect(mockSpawn.mock.calls.length).toBe(4);
      expect(spawnArgs(1)).toEqual(['daemon', 'restart']);
      expect(spawnArgs(2)).toEqual(['daemon', 'status']);
      expect(spawnArgs(3)).toEqual(['browser', 'work', 'state']);
    });
  });

  describe('execute - not-installed detection', () => {
    /** Make every install probe (npm root -g, where/which) report "not found". */
    async function mockNotInstalled() {
      const { spawnSync } = (await import('node:child_process')) as unknown as {
        spawnSync: ReturnType<typeof vi.fn>;
      };
      spawnSync.mockImplementation(() => ({ status: 1 }));
      return spawnSync;
    }

    it('should fail with not-installed (and never spawn) when opencli is missing', async () => {
      await mockNotInstalled();

      const result = await tool.execute(
        { args: ['doctor'] },
        new AbortController().signal,
      );

      // Detected before any process is launched.
      expect(mockSpawn.mock.calls.length).toBe(0);
      expect(result.status).toBe('failed');
      expect(result.errorKind).toBe('not-installed');
      expect(result.error).toContain('npm install -g @jackwener/opencli@latest');
      // We explicitly tell the agent no restart is needed.
      expect(result.error?.toLowerCase()).toContain('no restart');
    });

    it('should re-probe after install (a not-installed result is not cached)', async () => {
      const spawnSync = await mockNotInstalled();

      const first = await tool.execute(
        { args: ['doctor'] },
        new AbortController().signal,
      );
      expect(first.errorKind).toBe('not-installed');

      // Simulate `npm install -g` completing: the binary now resolves on PATH.
      spawnSync.mockImplementation((cmd) =>
        cmd === 'where' || cmd === 'which'
          ? { status: 0 }
          : { status: 1, error: new Error('not found') },
      );

      const child = nextChild();
      const promise = tool.execute(
        { args: ['doctor'] },
        new AbortController().signal,
      );
      child.emitStdout('ok');
      child.close(0);
      const second = await promise;

      expect(second.status).toBe('success');
      expect(mockSpawn.mock.calls[0][0]).toBe('opencli');
      expect(spawnArgs(0)).toEqual(['doctor']);
    });

    it('should use the opt-in npx fallback when OPENCLI_USE_NPX=1', async () => {
      await mockNotInstalled();
      process.env.OPENCLI_USE_NPX = '1';

      const child = nextChild();
      const promise = tool.execute(
        { args: ['doctor'] },
        new AbortController().signal,
      );
      child.emitStdout('ok');
      child.close(0);
      await promise;

      expect(mockSpawn.mock.calls.length).toBe(1);
      const isWin = process.platform === 'win32';
      expect(mockSpawn.mock.calls[0][0]).toBe(isWin ? 'npx.cmd' : 'npx');
      expect(spawnArgs(0)[0]).toBe('@jackwener/opencli@latest');
      expect(spawnArgs(0)[1]).toBe('doctor');
    });
  });

  describe('execute - explicit binaryPath escape hatch', () => {
    let tmpDir: string;
    let jsEntry: string;
    let binShim: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-bp-'));
      // A .js entry → run with node; a non-.js shim → run directly.
      jsEntry = path.join(tmpDir, 'main.js');
      binShim = path.join(tmpDir, 'opencli.cmd');
      fs.writeFileSync(jsEntry, '// fake entry');
      fs.writeFileSync(binShim, '@echo fake');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should run a JS entry path with node (shell:false)', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['doctor'], binaryPath: jsEntry },
        new AbortController().signal,
      );
      child.emitStdout('ok');
      child.close(0);
      await promise;

      expect(mockSpawn.mock.calls[0][0]).toBe(process.execPath);
      expect(spawnArgs(0)).toEqual([jsEntry, 'doctor']);
      expect(spawnOpts(0).shell).toBe(false);
    });

    it('should run a non-JS path directly as a binary', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { args: ['doctor'], binaryPath: binShim },
        new AbortController().signal,
      );
      child.emitStdout('ok');
      child.close(0);
      await promise;

      expect(mockSpawn.mock.calls[0][0]).toBe(binShim);
      expect(spawnArgs(0)).toEqual(['doctor']);
    });

    it('should take precedence over a cached auto-detected invocation', async () => {
      // Prime the cache with the default (PATH binary) resolution.
      const first = nextChild();
      const p1 = tool.execute({ args: ['doctor'] }, new AbortController().signal);
      first.emitStdout('ok');
      first.close(0);
      await p1;
      expect(mockSpawn.mock.calls[0][0]).toBe('opencli');

      // A later call with binaryPath must use the explicit path, not the cache.
      const second = nextChild();
      const p2 = tool.execute(
        { args: ['doctor'], binaryPath: jsEntry },
        new AbortController().signal,
      );
      second.emitStdout('ok');
      second.close(0);
      await p2;
      expect(mockSpawn.mock.calls[1][0]).toBe(process.execPath);
      expect(spawnArgs(1)).toEqual([jsEntry, 'doctor']);
    });

    it('should fail clearly when binaryPath does not exist', async () => {
      const result = await tool.execute(
        { args: ['doctor'], binaryPath: path.join(tmpDir, 'nope') },
        new AbortController().signal,
      );
      expect(mockSpawn.mock.calls.length).toBe(0);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('binaryPath');
    });
  });
});
