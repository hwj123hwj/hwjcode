/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isAllowedFeishuAuthCommand,
  buildFeishuCommandArgs,
  parseFeishuCommandStdout,
  FEISHU_AUTH_SUBCOMMANDS,
} from './feishuCommandRunner.js';

describe('isAllowedFeishuAuthCommand', () => {
  it('accepts each whitelisted subcommand', () => {
    for (const sub of FEISHU_AUTH_SUBCOMMANDS) {
      expect(isAllowedFeishuAuthCommand(`${sub} ou_x`)).toBe(true);
    }
  });

  it('accepts a bare allowlist verb (no argument)', () => {
    expect(isAllowedFeishuAuthCommand('allowlist')).toBe(true);
  });

  it('rejects empty / whitespace input', () => {
    expect(isAllowedFeishuAuthCommand('')).toBe(false);
    expect(isAllowedFeishuAuthCommand('   ')).toBe(false);
    expect(isAllowedFeishuAuthCommand(undefined as unknown as string)).toBe(false);
  });

  it('rejects non-authorization subcommands (logout/stop/setup/start)', () => {
    expect(isAllowedFeishuAuthCommand('logout')).toBe(false);
    expect(isAllowedFeishuAuthCommand('stop')).toBe(false);
    expect(isAllowedFeishuAuthCommand('setup --manual a b')).toBe(false);
    expect(isAllowedFeishuAuthCommand('start')).toBe(false);
  });

  it('requires the verb to be a standalone token (no prefix match)', () => {
    expect(isAllowedFeishuAuthCommand('allowfoo ou_x')).toBe(false);
    expect(isAllowedFeishuAuthCommand('ownerX ou_x')).toBe(false);
  });

  it('tolerates leading whitespace', () => {
    expect(isAllowedFeishuAuthCommand('  owner ou_x')).toBe(true);
  });
});

describe('buildFeishuCommandArgs', () => {
  it('passes the whole /feishu prompt as a single argv element', () => {
    const argv = buildFeishuCommandArgs('/path/easycode.js', 'owner ou_123');
    expect(argv).toEqual([
      '/path/easycode.js',
      '-p',
      '/feishu owner ou_123',
      '--output-format',
      'json',
    ]);
  });

  it('trims surrounding whitespace in args', () => {
    const argv = buildFeishuCommandArgs('entry.js', '  allow ou_9  ');
    expect(argv[2]).toBe('/feishu allow ou_9');
  });

  it('does not split an open_id with shell-special characters into extra argv', () => {
    // No shell is involved; the open_id stays inside the single prompt arg.
    const argv = buildFeishuCommandArgs('entry.js', 'allow ou_a;rm -rf /');
    expect(argv).toHaveLength(5);
    expect(argv[2]).toBe('/feishu allow ou_a;rm -rf /');
  });
});

describe('parseFeishuCommandStdout', () => {
  it('parses the json-mode final object (success)', () => {
    const stdout = JSON.stringify({
      model: 'auto',
      content: '✅ Set ou_abc as Bot Owner (marked verified).',
      status: 'success',
    });
    const r = parseFeishuCommandStdout(stdout);
    expect(r.status).toBe('success');
    expect(r.message).toMatch(/Set ou_abc as Bot Owner/);
    expect(r.error).toBeUndefined();
  });

  it('parses the json-mode final object (error)', () => {
    const stdout = JSON.stringify({
      model: 'auto',
      content: '',
      status: 'error',
      error: 'something went wrong',
    });
    const r = parseFeishuCommandStdout(stdout);
    expect(r.status).toBe('error');
    expect(r.error).toBe('something went wrong');
  });

  it('ignores boot/log noise around the JSON line', () => {
    const stdout = [
      'Loading settings...',
      '[telemetry] init',
      JSON.stringify({ model: 'auto', content: 'ℹ️ ou_x is already in the authorization allowlist.', status: 'success' }),
      'Done.',
    ].join('\n');
    const r = parseFeishuCommandStdout(stdout);
    expect(r.status).toBe('success');
    expect(r.message).toMatch(/already in the authorization allowlist/);
  });

  it('parses stream-json assistant message + result events', () => {
    const stdout = [
      JSON.stringify({ type: 'init', session_id: 's1', model: 'auto', timestamp: 't' }),
      JSON.stringify({ type: 'message', role: 'user', content: '/feishu allow ou_x', timestamp: 't' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: '✅ Added ou_x to the authorization allowlist (total 1).', timestamp: 't' }),
      JSON.stringify({ type: 'result', status: 'success', timestamp: 't' }),
    ].join('\n');
    const r = parseFeishuCommandStdout(stdout);
    expect(r.message).toMatch(/Added ou_x to the authorization allowlist/);
    expect(r.status).toBe('success');
  });

  it('parses a stream-json error event', () => {
    const stdout = [
      JSON.stringify({ type: 'error', error: 'Command /feishu failed: boom', timestamp: 't' }),
      JSON.stringify({ type: 'result', status: 'error', timestamp: 't' }),
    ].join('\n');
    const r = parseFeishuCommandStdout(stdout);
    expect(r.error).toBe('Command /feishu failed: boom');
    expect(r.status).toBe('error');
  });

  it('returns an empty object when there is no parseable JSON', () => {
    expect(parseFeishuCommandStdout('just some text\nno json here')).toEqual({});
    expect(parseFeishuCommandStdout('')).toEqual({});
  });

  it('lets a later result object override an earlier assistant message', () => {
    const stdout = [
      JSON.stringify({ type: 'message', role: 'assistant', content: 'first', timestamp: 't' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'second', timestamp: 't' }),
    ].join('\n');
    const r = parseFeishuCommandStdout(stdout);
    expect(r.message).toBe('second');
  });
});
