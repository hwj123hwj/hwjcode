/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * A module-level registry for integrated-terminal sessions. The shells live in
 * the main process as real PTYs; here we keep one long-lived xterm.js `Terminal`
 * instance per tab (plus its FitAddon and a detached host `<div>`), so the
 * terminal — scrollback, cursor, running TUIs and all — survives the
 * BottomTerminal component unmounting (e.g. when the bottom panel is toggled
 * closed and reopened). The React component only re-attaches each tab's host div
 * into the visible DOM and refits it; all the heavy state lives here.
 *
 * The lightweight tab list (id / title / exited / active) is exposed to React
 * via useSyncExternalStore; the xterm instances themselves are fetched by id and
 * never put through React state (they would churn re-renders for nothing).
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalDataEvent, TerminalExitEvent } from '@shared/ipc';
import { buildXtermTheme } from './terminalTheme';

const api = window.easycode;

/** A live terminal tab: the PTY id plus its renderer-side xterm machinery. */
interface Term {
  id: string;
  title: string;
  exited: boolean;
  term: Terminal;
  fit: FitAddon;
  /** Detached host element xterm renders into; re-parented by the component. */
  container: HTMLDivElement;
}

/** The minimal per-tab shape React needs to render the tab strip. */
export interface TermSnapshot {
  id: string;
  title: string;
  exited: boolean;
}

type Listener = () => void;

class TerminalStore {
  private terms: Term[] = [];
  private snapshot: TermSnapshot[] = [];
  private activeId: string | null = null;
  private listeners = new Set<Listener>();
  private wired = false;

  private rebuildSnapshot() {
    this.snapshot = this.terms.map((t) => ({ id: t.id, title: t.title, exited: t.exited }));
  }

  private emit() {
    this.rebuildSnapshot();
    for (const l of this.listeners) l();
  }

  /** Wire the main→renderer event streams exactly once. */
  private wire() {
    if (this.wired) return;
    this.wired = true;
    api.terminal.onData((e: TerminalDataEvent) => this.write(e.id, e.data));
    api.terminal.onExit((e: TerminalExitEvent) => this.markExited(e.id, e.code));
    // Re-tint open terminals when the OS color scheme flips while we're in
    // 'system' mode (an explicit light/dark switch is pushed via applyTheme()).
    try {
      window
        .matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', () => this.applyTheme());
    } catch {
      /* matchMedia unavailable — ignore */
    }
  }

  /** Re-derive the xterm palette from the current app theme and apply it to all
   *  open terminals. Called by <App> whenever the theme preference changes. */
  applyTheme = (): void => {
    const theme = buildXtermTheme();
    for (const t of this.terms) t.term.options.theme = theme;
  };

  subscribe = (l: Listener): (() => void) => {
    this.wire();
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getTerms = (): TermSnapshot[] => this.snapshot;
  getActiveId = (): string | null => this.activeId;

  /** The live xterm machinery for a tab (used by the component to attach it). */
  getTerm(id: string): Term | undefined {
    return this.terms.find((t) => t.id === id);
  }

  private write(id: string, data: string) {
    this.getTerm(id)?.term.write(data);
  }

  private markExited(id: string, code: number) {
    const t = this.getTerm(id);
    if (!t) return;
    t.exited = true;
    t.term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
    this.emit();
  }

  /** Spawn a new shell tab; returns its id (also made active). */
  async create(cwd?: string): Promise<string> {
    this.wire();
    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 8000,
      theme: buildXtermTheme(),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const container = document.createElement('div');
    container.className = 'xterm-host';
    term.open(container);

    const handle = await api.terminal.create(cwd, term.cols, term.rows);
    const id = handle.id;

    // Surface any main-process notice (e.g. the chosen shell wasn't found and we
    // fell back) as a dim banner line before the shell's own first output.
    if (handle.notice) {
      term.write(`\x1b[2m${handle.notice}\x1b[0m\r\n`);
    }

    // Forward keystrokes (incl. control chars / paste) straight to the PTY, and
    // mirror any grid resize the user triggers (font zoom, fit) back to the PTY.
    term.onData((d) => api.terminal.input(id, d));
    term.onResize(({ cols, rows }) => api.terminal.resize(id, cols, rows));

    const n = this.terms.length + 1;
    this.terms = [...this.terms, { id, title: `${n}`, exited: false, term, fit, container }];
    this.activeId = id;
    this.emit();
    return id;
  }

  setActive(id: string) {
    if (this.activeId === id) return;
    this.activeId = id;
    this.emit();
  }

  /** Fit the tab's xterm to its current host size and push the grid to the PTY. */
  fit(id: string) {
    const t = this.getTerm(id);
    if (!t) return;
    try {
      t.fit.fit();
      if (!t.exited) api.terminal.resize(id, t.term.cols, t.term.rows);
    } catch {
      /* host not laid out yet — ignore; a later fit() will catch up */
    }
  }

  /** Move keyboard focus into the tab's terminal. */
  focus(id: string) {
    this.getTerm(id)?.term.focus();
  }

  close(id: string) {
    void api.terminal.close(id);
    const t = this.getTerm(id);
    t?.term.dispose();
    t?.container.remove();
    const wasActive = this.activeId === id;
    const idx = this.terms.findIndex((x) => x.id === id);
    this.terms = this.terms.filter((x) => x.id !== id);
    if (wasActive) {
      const next = this.terms[Math.min(idx, this.terms.length - 1)];
      this.activeId = next ? next.id : null;
    }
    this.emit();
  }
}

export const terminalStore = new TerminalStore();
