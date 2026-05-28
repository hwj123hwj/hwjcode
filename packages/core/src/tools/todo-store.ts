/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';

/** Todo data model shared across the todo tool and the UI. */
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export type TodoStatus = TodoItem['status'];
export type TodoPriority = TodoItem['priority'];

const UPDATE_EVENT = 'update';

/**
 * Reactive, in-memory store for the current todo list.
 *
 * The list is replaced wholesale on every `todo_write` call. Subscribers
 * (e.g. the pinned TodoPanel in the CLI) get notified via the `update` event
 * so they can re-render in place instead of relying on repeated scrollback
 * entries.
 */
class TodoStore extends EventEmitter {
  private todos: TodoItem[] = [];

  /** Returns a defensive copy of the current todos. */
  getTodos(): TodoItem[] {
    return this.todos.map((t) => ({ ...t }));
  }

  /** Replaces the entire list and notifies subscribers. */
  setTodos(todos: TodoItem[]): void {
    this.todos = todos.map((t) => ({ ...t }));
    this.emit(UPDATE_EVENT, this.getTodos());
  }

  /** Clears the list (e.g. on a new session) and notifies subscribers. */
  clear(): void {
    this.todos = [];
    this.emit(UPDATE_EVENT, this.getTodos());
  }

  /** Subscribe to list changes. Receives a copy of the new list. */
  onUpdate(callback: (todos: TodoItem[]) => void): void {
    this.on(UPDATE_EVENT, callback);
  }

  /** Unsubscribe a previously registered listener. */
  offUpdate(callback: (todos: TodoItem[]) => void): void {
    this.off(UPDATE_EVENT, callback);
  }
}

export const todoStore = new TodoStore();
