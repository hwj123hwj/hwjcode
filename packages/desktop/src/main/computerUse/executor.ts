/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "computer use" executor — the harness half of a Codex/Claude-style
 * screenshot→action loop (see https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool).
 *
 * The agent (running in the spawned `easycode --acp` backend) perceives the
 * screen through screenshots and emits low-level UI actions in *screenshot
 * pixel space*; this executor:
 *   - captures the primary display via Electron `desktopCapturer` (no native
 *     dependency for capture), downscaled to a model-friendly size, and
 *   - injects real OS mouse/keyboard events via `@nut-tree-fork/nut-js` (the
 *     only piece that needs a native module — its libnut N-API binaries are
 *     ABI-stable and ship prebuilt, so they load in Electron with no rebuild,
 *     exactly like @lydell/node-pty).
 *
 * Coordinates are mapped *fractionally* from the screenshot the model looked at
 * onto nut.js's screen space, so the loop is robust to DPI scaling and to any
 * mismatch between the captured image size and the OS pixel grid: both cover the
 * same full primary display, so `frac = modelX / imageWidth` → `nutX = frac *
 * nutWidth` lands on the right spot regardless of absolute pixel counts.
 *
 * nut.js is imported lazily (on the first real action) so the native module —
 * and, on macOS, the Accessibility/Screen-Recording implications — is never
 * loaded unless the user actually enables and exercises computer use.
 */

import { clipboard, desktopCapturer, screen as electronScreen } from 'electron';
import { withEscPassthrough } from './escStop';

/** The discrete actions the agent can emit, mirroring Claude's `computer_20251124`. */
export type ComputerAction =
  | 'screenshot'
  | 'cursor_position'
  | 'mouse_move'
  | 'left_click'
  | 'right_click'
  | 'middle_click'
  | 'double_click'
  | 'triple_click'
  | 'left_mouse_down'
  | 'left_mouse_up'
  | 'left_click_drag'
  | 'left_click_path'
  | 'type'
  | 'key'
  | 'scroll'
  | 'wait';

export interface ComputerActionParams {
  /** [x, y] in screenshot-pixel space (the image the model last saw). */
  coordinate?: [number, number];
  /** Drag start in screenshot-pixel space (for `left_click_drag`). */
  start_coordinate?: [number, number];
  /** Freehand polyline in screenshot-pixel space (for `left_click_path` — drawing). */
  path?: Array<[number, number]>;
  /** Text to type (`type`) or a key combo like "ctrl+s" / "Return" (`key`). */
  text?: string;
  scroll_direction?: 'up' | 'down' | 'left' | 'right';
  scroll_amount?: number;
  /** Seconds, for `wait`. */
  duration?: number;
}

export interface Screenshot {
  /** base64 JPEG, WITHOUT the `data:` prefix. */
  data: string;
  mimeType: 'image/jpeg';
  /** Logical dimensions the model should treat as the coordinate space. */
  width: number;
  height: number;
}

/** Result of executing one action: a status line plus the resulting screen. */
export interface ActionResult {
  text: string;
  /** Present for every action except `wait`/`cursor_position` where it adds nothing. */
  screenshot?: Screenshot;
}

/** Longest edge of the screenshot handed to the model. Caps token cost while
 *  staying sharp enough for accurate clicking — Claude's recommended WXGA
 *  (1280×800) ceiling. Image tokens scale with AREA, so dropping from 1366→1280
 *  trims ~12% off every screenshot's think cost at no real accuracy loss. */
const MAX_IMAGE_EDGE = 1280;

/** JPEG quality for screenshots. PNG is the worst choice for a screen capture:
 *  slow to encode and several times larger on the wire. JPEG at this quality is
 *  visually indistinguishable for UI text/icons but encodes far faster and ships
 *  a fraction of the bytes (note: for vision models the image *token* count
 *  depends on dimensions, not bytes — so this is a capture/transfer win, while
 *  {@link MAX_IMAGE_EDGE} is the lever for think-token cost). */
const JPEG_QUALITY = 70;

/** nut.js lazily imported — see file header for why. */
type NutModule = typeof import('@nut-tree-fork/nut-js');

export class ComputerUseExecutor {
  private nut?: NutModule;
  /** Dimensions of the most recent screenshot returned to the model — the space
   *  its coordinates are expressed in. Updated on every capture. */
  private lastImage?: { width: number; height: number };

  // ── nut.js bootstrap ──────────────────────────────────────────────────────

  private async loadNut(): Promise<NutModule> {
    if (!this.nut) {
      this.nut = await import('@nut-tree-fork/nut-js');
      // Tighten the default 100ms auto-delays so multi-step loops aren't
      // glacial, but keep a small settle so target apps register the events.
      this.nut.mouse.config.autoDelayMs = 8;
      this.nut.keyboard.config.autoDelayMs = 4;
    }
    return this.nut;
  }

  // ── screenshot ──────────────────────────────────────────────────────────

  /** Capture the primary display, downscaled to {@link MAX_IMAGE_EDGE}. */
  async capture(): Promise<Screenshot> {
    const display = electronScreen.getPrimaryDisplay();
    const { width: dipW, height: dipH } = display.size;
    const scale = display.scaleFactor || 1;
    const physW = Math.round(dipW * scale);
    const physH = Math.round(dipH * scale);
    // Ask the OS/compositor to downscale DURING capture rather than grabbing the
    // full physical resolution (5K/4K = a huge buffer) and resizing in JS. On
    // Windows `desktopCapturer.getSources` cost scales with the requested
    // thumbnail size, so requesting the target size directly is markedly faster
    // and allocates far less memory per capture.
    const longestPhys = Math.max(physW, physH);
    const ratio = longestPhys > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longestPhys : 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(physW * ratio),
        height: Math.round(physH * ratio),
      },
    });
    // Prefer the source matching the primary display id; fall back to the first.
    const primaryId = String(display.id);
    const source =
      sources.find((s) => s.display_id === primaryId) ?? sources[0];
    if (!source) throw new Error('No screen source available to capture.');

    let image = source.thumbnail;
    const size = image.getSize();
    // Safety net: if the backend ignored thumbnailSize and handed back something
    // larger, clamp it ourselves so the model's coordinate space is bounded.
    const longest = Math.max(size.width, size.height);
    if (longest > MAX_IMAGE_EDGE) {
      const r = MAX_IMAGE_EDGE / longest;
      image = image.resize({
        width: Math.round(size.width * r),
        height: Math.round(size.height * r),
      });
    }
    const out = image.getSize();
    this.lastImage = { width: out.width, height: out.height };
    return {
      data: image.toJPEG(JPEG_QUALITY).toString('base64'),
      mimeType: 'image/jpeg',
      width: out.width,
      height: out.height,
    };
  }

  // ── coordinate mapping ────────────────────────────────────────────────────

  /** Map a screenshot-space point onto nut.js screen space (fractional). */
  private async toScreenPoint(x: number, y: number): Promise<{ x: number; y: number }> {
    const nut = await this.loadNut();
    // Establish the reference image space if the model jumped straight to an
    // action without screenshotting first.
    if (!this.lastImage) await this.capture();
    const img = this.lastImage!;
    const nutW = await nut.screen.width();
    const nutH = await nut.screen.height();
    const fracX = Math.min(1, Math.max(0, x / img.width));
    const fracY = Math.min(1, Math.max(0, y / img.height));
    return { x: Math.round(fracX * nutW), y: Math.round(fracY * nutH) };
  }

  // ── text entry ────────────────────────────────────────────────────────────

  /**
   * Type `text` into the focused field.
   *
   * `nut.keyboard.type` simulates *physical* key presses, so it can only emit
   * characters reachable on the active keyboard layout — pure ASCII, basically.
   * Hand it CJK/emoji/other Unicode and the OS maps the synthetic keystrokes
   * through the current IME/layout and you get garbage (e.g. Chinese arriving as
   * "ao/1 Eaasy Code \"). For any text containing a non-ASCII character we route
   * through the clipboard instead — set it, paste with the platform paste combo,
   * then restore whatever the user had — which is layout/IME-independent and the
   * standard approach for Unicode entry in computer-use harnesses.
   */
  private async typeText(text: string): Promise<void> {
    const nut = await this.loadNut();
    // Fast path: pure ASCII types fine as real keystrokes (and behaves more like
    // genuine typing for fields that react per-keypress).
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7F]*$/.test(text)) {
      await nut.keyboard.type(text);
      return;
    }

    const { Key } = nut;
    const previous = clipboard.readText();
    try {
      clipboard.writeText(text);
      const pasteMod = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
      await nut.keyboard.pressKey(pasteMod, Key.V);
      await nut.keyboard.releaseKey(Key.V, pasteMod);
    } finally {
      // Restore the user's clipboard so computer use doesn't clobber it. Small
      // delay so the paste consumes the new value before we put the old back.
      await nut.sleep(40);
      clipboard.writeText(previous);
    }
  }

  // ── action dispatch ───────────────────────────────────────────────────────

  /**
   * Execute one action and (for state-changing actions) return a fresh
   * screenshot so the caller can feed the new screen back to the model.
   * `signal` lets a kill-switch abort a long path mid-stroke.
   */
  async execute(
    action: ComputerAction,
    params: ComputerActionParams,
    signal?: AbortSignal,
    opts?: { screenshot?: boolean },
  ): Promise<ActionResult> {
    const nut = await this.loadNut();
    const { Point, Button, Key } = nut;
    // Attach a fresh screenshot only when the caller wants to observe the result.
    // Batched / deterministic steps pass screenshot:false to stay cheap and fast,
    // capturing once at the end instead of after every single action.
    const withShot = opts?.screenshot !== false;
    const shot = async (text: string): Promise<ActionResult> =>
      withShot ? { text, screenshot: await this.capture() } : { text };
    const checkAbort = () => {
      if (signal?.aborted) throw new Error('Computer use was stopped by the user.');
    };

    const moveTo = async (c?: [number, number]) => {
      if (!c) return;
      const p = await this.toScreenPoint(c[0], c[1]);
      await nut.mouse.setPosition(new Point(p.x, p.y));
    };

    // Modifier keys (held during a click/scroll) ride in `params.text`, e.g.
    // "shift" or "ctrl" — matching Claude's `text` convention on those actions.
    const withModifiers = async <T>(fn: () => Promise<T>): Promise<T> => {
      const mods =
        action === 'left_click' ||
        action === 'right_click' ||
        action === 'middle_click' ||
        action === 'double_click' ||
        action === 'scroll'
          ? parseModifiers(params.text)
          : [];
      const keys = mods.map((m) => modifierKey(Key, m)).filter((k): k is number => k != null);
      for (const k of keys) await nut.keyboard.pressKey(k);
      try {
        return await fn();
      } finally {
        for (const k of [...keys].reverse()) await nut.keyboard.releaseKey(k);
      }
    };

    checkAbort();
    switch (action) {
      case 'screenshot':
        return { text: 'Captured screenshot.', screenshot: await this.capture() };

      case 'cursor_position': {
        const pos = await nut.mouse.getPosition();
        return { text: `Cursor at (${pos.x}, ${pos.y}) in screen space.` };
      }

      case 'mouse_move':
        await moveTo(params.coordinate);
        return shot('Moved cursor.');

      case 'left_click':
        await moveTo(params.coordinate);
        await withModifiers(() => nut.mouse.leftClick());
        return shot('Left click.');

      case 'right_click':
        await moveTo(params.coordinate);
        await withModifiers(() => nut.mouse.rightClick());
        return shot('Right click.');

      case 'middle_click':
        await moveTo(params.coordinate);
        await withModifiers(() => nut.mouse.click(Button.MIDDLE));
        return shot('Middle click.');

      case 'double_click':
        await moveTo(params.coordinate);
        await withModifiers(() => nut.mouse.doubleClick(Button.LEFT));
        return shot('Double click.');

      case 'triple_click':
        await moveTo(params.coordinate);
        await nut.mouse.leftClick();
        await nut.mouse.leftClick();
        await nut.mouse.leftClick();
        return shot('Triple click.');

      case 'left_mouse_down':
        await moveTo(params.coordinate);
        await nut.mouse.pressButton(Button.LEFT);
        return { text: 'Left mouse button down.' };

      case 'left_mouse_up':
        await moveTo(params.coordinate);
        await nut.mouse.releaseButton(Button.LEFT);
        return shot('Left mouse button up.');

      case 'left_click_drag': {
        const start = params.start_coordinate ?? params.coordinate;
        const end = params.coordinate;
        if (!start || !end) throw new Error('left_click_drag needs start_coordinate and coordinate.');
        await moveTo(start);
        await nut.mouse.pressButton(Button.LEFT);
        await moveTo(end);
        await nut.mouse.releaseButton(Button.LEFT);
        return shot('Dragged.');
      }

      case 'left_click_path': {
        const path = params.path;
        if (!path || path.length < 2) throw new Error('left_click_path needs a path of ≥2 points.');
        await moveTo(path[0]);
        await nut.mouse.pressButton(Button.LEFT);
        try {
          for (let i = 1; i < path.length; i++) {
            checkAbort();
            const p = await this.toScreenPoint(path[i][0], path[i][1]);
            await nut.mouse.setPosition(new Point(p.x, p.y));
          }
        } finally {
          await nut.mouse.releaseButton(Button.LEFT);
        }
        return shot(`Drew a ${path.length}-point stroke.`);
      }

      case 'type': {
        const text = params.text ?? '';
        if (text) await this.typeText(text);
        return shot(`Typed ${text.length} characters.`);
      }

      case 'key': {
        const combo = params.text ?? '';
        const keys = combo
          .split('+')
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => mapKeyName(Key, t))
          .filter((k): k is number => k != null);
        if (!keys.length) throw new Error(`Unrecognized key combo: "${combo}".`);
        const press = async () => {
          for (const k of keys) await nut.keyboard.pressKey(k);
          for (const k of [...keys].reverse()) await nut.keyboard.releaseKey(k);
        };
        // If the agent itself presses Escape, momentarily release our global
        // Esc-to-stop hotkey so the keystroke reaches the target app rather than
        // being captured as a user stop request.
        if (/(?:^|\+)\s*(?:esc|escape)\s*(?:$|\+)/i.test(combo)) {
          await withEscPassthrough(press);
        } else {
          await press();
        }
        return shot(`Pressed ${combo}.`);
      }

      case 'scroll': {
        await moveTo(params.coordinate);
        const amount = Math.max(1, params.scroll_amount ?? 3);
        await withModifiers(async () => {
          switch (params.scroll_direction) {
            case 'up':
              return nut.mouse.scrollUp(amount);
            case 'left':
              return nut.mouse.scrollLeft(amount);
            case 'right':
              return nut.mouse.scrollRight(amount);
            case 'down':
            default:
              return nut.mouse.scrollDown(amount);
          }
        });
        return shot(`Scrolled ${params.scroll_direction ?? 'down'} ${amount}.`);
      }

      case 'wait': {
        const ms = Math.min(10000, Math.max(0, (params.duration ?? 1) * 1000));
        await nut.sleep(ms);
        return shot(`Waited ${ms}ms.`);
      }

      default:
        throw new Error(`Unsupported action: ${action as string}`);
    }
  }
}

// ── key mapping ───────────────────────────────────────────────────────────

type KeyEnum = NutModule['Key'];

/** Split a click/scroll `text` field into modifier tokens. */
function parseModifiers(text?: string): string[] {
  if (!text) return [];
  return text
    .split('+')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function modifierKey(Key: KeyEnum, name: string): number | undefined {
  switch (name) {
    case 'ctrl':
    case 'control':
      return Key.LeftControl as unknown as number;
    case 'shift':
      return Key.LeftShift as unknown as number;
    case 'alt':
    case 'option':
      return Key.LeftAlt as unknown as number;
    case 'super':
    case 'cmd':
    case 'command':
    case 'win':
    case 'meta':
      return Key.LeftSuper as unknown as number;
    default:
      return undefined;
  }
}

/**
 * Map a single key token (xdotool / Claude-style names the model emits, e.g.
 * "Return", "ctrl", "Page_Down", "a", "F5") onto a nut.js `Key` enum value.
 */
function mapKeyName(Key: KeyEnum, raw: string): number | undefined {
  const t = raw.trim();
  const lower = t.toLowerCase();
  const mod = modifierKey(Key, lower);
  if (mod != null) return mod;

  const named: Record<string, keyof KeyEnum> = {
    return: 'Enter',
    enter: 'Enter',
    tab: 'Tab',
    escape: 'Escape',
    esc: 'Escape',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Delete',
    del: 'Delete',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    home: 'Home',
    end: 'End',
    page_up: 'PageUp',
    pageup: 'PageUp',
    prior: 'PageUp',
    page_down: 'PageDown',
    pagedown: 'PageDown',
    next: 'PageDown',
    insert: 'Insert',
    minus: 'Minus',
    plus: 'Add',
    equal: 'Equal',
    period: 'Period',
    comma: 'Comma',
    slash: 'Slash',
    backslash: 'Backslash',
    semicolon: 'Semicolon',
    grave: 'Grave',
    capslock: 'CapsLock',
  };
  if (named[lower] && (Key as Record<string, unknown>)[named[lower] as string] != null) {
    return (Key as unknown as Record<string, number>)[named[lower] as string];
  }

  // Function keys F1..F24
  const fmatch = /^f(\d{1,2})$/.exec(lower);
  if (fmatch) {
    const k = `F${fmatch[1]}`;
    if ((Key as Record<string, unknown>)[k] != null) {
      return (Key as unknown as Record<string, number>)[k];
    }
  }

  // Single letter → uppercase enum name (Key.A … Key.Z).
  if (/^[a-z]$/.test(lower)) {
    return (Key as unknown as Record<string, number>)[lower.toUpperCase()];
  }
  // Single digit → Key.Num0 … Key.Num9.
  if (/^[0-9]$/.test(lower)) {
    return (Key as unknown as Record<string, number>)[`Num${lower}`];
  }
  // Last resort: exact enum name match (e.g. "LeftControl", "F5").
  if ((Key as Record<string, unknown>)[t] != null) {
    return (Key as unknown as Record<string, number>)[t];
  }
  return undefined;
}
