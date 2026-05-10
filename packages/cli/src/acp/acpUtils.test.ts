/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Kind, ApprovalMode } from 'deepv-code-core';
import {
  buildAvailableModes,
  hasMeta,
  toAcpToolKind,
} from './acpUtils.js';

describe('hasMeta', () => {
  it('detects objects with a `_meta` property', () => {
    expect(hasMeta({ _meta: {} })).toBe(true);
  });
  it('returns false for plain objects', () => {
    expect(hasMeta({})).toBe(false);
    expect(hasMeta(null)).toBe(false);
    expect(hasMeta('x')).toBe(false);
  });
});

describe('toAcpToolKind', () => {
  it('passes through known kinds', () => {
    expect(toAcpToolKind(Kind.Read)).toBe('read');
    expect(toAcpToolKind(Kind.Edit)).toBe('edit');
    expect(toAcpToolKind(Kind.Execute)).toBe('execute');
    expect(toAcpToolKind(Kind.Fetch)).toBe('fetch');
  });

  it('collapses non-ACP kinds to `other`', () => {
    expect(toAcpToolKind(Kind.Plan)).toBe('other');
    expect(toAcpToolKind(Kind.Communicate)).toBe('other');
    expect(toAcpToolKind(Kind.SwitchMode)).toBe('other');
  });

  it('maps the Agent kind to `think`', () => {
    expect(toAcpToolKind(Kind.Agent)).toBe('think');
  });
});

describe('buildAvailableModes', () => {
  it('includes the three DeepCode approval modes', () => {
    const modes = buildAvailableModes();
    const ids = modes.map((m) => m.id);
    expect(ids).toContain(ApprovalMode.DEFAULT);
    expect(ids).toContain(ApprovalMode.AUTO_EDIT);
    expect(ids).toContain(ApprovalMode.YOLO);
  });

  it('ignores the isPlanEnabled flag (DeepCode has no Plan mode)', () => {
    const defaultModes = buildAvailableModes(false);
    const planModes = buildAvailableModes(true);
    expect(planModes.length).toBe(defaultModes.length);
  });
});
