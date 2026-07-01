/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import {
  sessionHistoryPath,
  extractHistoryText,
  buildSnippet,
  findSnippet,
} from './sessionSearch.js';

describe('sessionHistoryPath', () => {
  it('derives ~/.easycode-user/tmp/<sha256(cwd)>/sessions/<id>/history.json', () => {
    const p = sessionHistoryPath('C:/proj/demo', 'abc-123');
    expect(p).toContain(os.homedir());
    expect(p).toContain('.easycode-user');
    expect(p.replace(/\\/g, '/')).toMatch(/\/tmp\/[0-9a-f]{64}\/sessions\/abc-123\/history\.json$/);
  });

  it('is deterministic for the same cwd + id', () => {
    expect(sessionHistoryPath('/a', 'x')).toBe(sessionHistoryPath('/a', 'x'));
  });

  it('changes with the cwd (per-project hashing)', () => {
    expect(sessionHistoryPath('/a', 'x')).not.toBe(sessionHistoryPath('/b', 'x'));
  });
});

describe('extractHistoryText', () => {
  it('pulls part text from user/model turns', () => {
    const raw = [
      { role: 'user', parts: [{ text: 'how do I build this' }] },
      { role: 'model', parts: [{ text: 'run npm run build' }] },
    ];
    expect(extractHistoryText(raw)).toEqual(['how do I build this', 'run npm run build']);
  });

  it('skips the injected system-context preamble', () => {
    const raw = [
      { role: 'user', parts: [{ text: '🚀 **CRITICAL SYSTEM CONTEXT - Easy Code** date/platform…' }] },
      { role: 'user', parts: [{ text: 'real question' }] },
    ];
    expect(extractHistoryText(raw)).toEqual(['real question']);
  });

  it('strips system-reminder blocks and collapses whitespace', () => {
    const raw = [{ role: 'user', parts: [{ text: 'keep this\n\n<system-reminder>hidden</system-reminder>  tail' }] }];
    expect(extractHistoryText(raw)).toEqual(['keep this tail']);
  });

  it('tolerates non-array / malformed input', () => {
    expect(extractHistoryText(null)).toEqual([]);
    expect(extractHistoryText({})).toEqual([]);
    expect(extractHistoryText([{ role: 'user' }, { parts: 'x' }])).toEqual([]);
  });
});

describe('buildSnippet', () => {
  it('centres on the match with ellipses when clipped', () => {
    const text = 'a'.repeat(80) + 'NEEDLE' + 'b'.repeat(80);
    const s = buildSnippet(text, 'needle', 10)!;
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.toLowerCase()).toContain('needle');
  });

  it('omits leading ellipsis when the match is near the start', () => {
    expect(buildSnippet('hello world here', 'hello', 20)).toBe('hello world here');
  });

  it('returns null when the query is absent', () => {
    expect(buildSnippet('nothing here', 'xyz')).toBeNull();
  });
});

describe('findSnippet', () => {
  it('returns the first matching segment snippet', () => {
    expect(findSnippet(['alpha beta', 'gamma delta'], 'gamma')).toBe('gamma delta');
  });
  it('returns null when no segment matches', () => {
    expect(findSnippet(['alpha', 'beta'], 'zeta')).toBeNull();
  });
});
