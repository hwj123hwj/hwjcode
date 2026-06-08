/**
 * @license
 * Copyright 2025 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseDelegatePrefix,
  resolveDelegation,
  buildDelegateDirective,
  parseBindAgentFlag,
} from './delegateDirective.js';

describe('parseDelegatePrefix', () => {
  it.each([
    ['@cc fix the bug', 'fix the bug'],
    ['/cc fix the bug', 'fix the bug'],
    ['@CC Fix It', 'Fix It'],
    ['/claude-code do x', 'do x'],
    ['@claudecode  do  y', 'do  y'],
    ['@cc: refactor', 'refactor'],
    ['@cc：重构一下', '重构一下'],
  ])('matches prefix in %j', (input, task) => {
    const r = parseDelegatePrefix(input);
    expect(r.matched).toBe(true);
    expect(r.task).toBe(task);
  });

  it('does not match a bare word or unrelated text', () => {
    expect(parseDelegatePrefix('ccc do x').matched).toBe(false);
    expect(parseDelegatePrefix('please fix').matched).toBe(false);
    expect(parseDelegatePrefix('account stuff').matched).toBe(false);
  });

  it('handles empty/undefined input', () => {
    expect(parseDelegatePrefix('').matched).toBe(false);
    // @ts-expect-error testing undefined robustness
    expect(parseDelegatePrefix(undefined).matched).toBe(false);
  });
});

describe('resolveDelegation', () => {
  it('prefix wins regardless of default agent', () => {
    const r = resolveDelegation('@cc do x', 'self');
    expect(r).toMatchObject({ delegate: true, agent: 'claude-code', task: 'do x', reason: 'prefix' });
  });

  it('delegates when chat default agent is claude-code', () => {
    const r = resolveDelegation('do x', 'claude-code');
    expect(r).toMatchObject({ delegate: true, task: 'do x', reason: 'route' });
  });

  it('does not delegate by default', () => {
    const r = resolveDelegation('do x');
    expect(r.delegate).toBe(false);
    expect(r.reason).toBe('none');
  });

  it('does not delegate when default agent is self', () => {
    expect(resolveDelegation('do x', 'self').delegate).toBe(false);
  });
});

describe('buildDelegateDirective', () => {
  it('embeds the task and names the tool', () => {
    const d = buildDelegateDirective('add tests');
    expect(d).toContain('delegate_to_claude_code');
    expect(d).toContain('add tests');
  });
});

describe('parseBindAgentFlag', () => {
  it('extracts --agent and leaves the path', () => {
    const r = parseBindAgentFlag('D:\\proj --agent claude-code');
    expect(r.agent).toBe('claude-code');
    expect(r.rest).toBe('D:\\proj');
  });

  it('supports --agent=value and cc alias', () => {
    expect(parseBindAgentFlag('--agent=cc').agent).toBe('claude-code');
    expect(parseBindAgentFlag('/path -a self').agent).toBe('self');
  });

  it('returns undefined agent when flag absent', () => {
    const r = parseBindAgentFlag('D:\\proj');
    expect(r.agent).toBeUndefined();
    expect(r.rest).toBe('D:\\proj');
  });

  it('ignores invalid agent value', () => {
    const r = parseBindAgentFlag('D:\\proj --agent bogus');
    expect(r.agent).toBeUndefined();
    expect(r.rest).toBe('D:\\proj');
  });
});
