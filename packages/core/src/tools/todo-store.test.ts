/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { todoStore, type TodoItem } from './todo-store.js';

const sample = (overrides: Partial<TodoItem> = {}): TodoItem => ({
  id: 'task_1',
  content: 'Do the thing',
  status: 'pending',
  priority: 'high',
  ...overrides,
});

describe('todoStore', () => {
  afterEach(() => {
    // Reset shared singleton state between tests.
    todoStore.clear();
    todoStore.removeAllListeners();
  });

  it('starts empty', () => {
    expect(todoStore.getTodos()).toEqual([]);
  });

  it('returns a defensive copy from getTodos', () => {
    todoStore.setTodos([sample()]);
    const a = todoStore.getTodos();
    a.push(sample({ id: 'task_2' }));
    expect(todoStore.getTodos()).toHaveLength(1);
  });

  it('replaces the whole list on setTodos', () => {
    todoStore.setTodos([sample({ id: 'a' }), sample({ id: 'b' })]);
    todoStore.setTodos([sample({ id: 'c' })]);
    expect(todoStore.getTodos().map((t) => t.id)).toEqual(['c']);
  });

  it('emits an update with the new list on setTodos', () => {
    const listener = vi.fn();
    todoStore.onUpdate(listener);
    const items = [sample({ id: 'x' })];
    todoStore.setTodos(items);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([sample({ id: 'x' })]);
    // Listener receives a copy, not the internal array reference.
    expect(listener.mock.calls[0][0]).not.toBe(items);
  });

  it('emits an empty update on clear', () => {
    todoStore.setTodos([sample()]);
    const listener = vi.fn();
    todoStore.onUpdate(listener);
    todoStore.clear();
    expect(listener).toHaveBeenCalledWith([]);
    expect(todoStore.getTodos()).toEqual([]);
  });

  it('stops notifying after offUpdate', () => {
    const listener = vi.fn();
    todoStore.onUpdate(listener);
    todoStore.offUpdate(listener);
    todoStore.setTodos([sample()]);
    expect(listener).not.toHaveBeenCalled();
  });
});
