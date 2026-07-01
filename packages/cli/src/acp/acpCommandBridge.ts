/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, GitService, Logger } from 'deepv-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type {
  CommandContext as CliCommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from '../ui/commands/types.js';
import { BuiltinCommandLoader } from '../services/BuiltinCommandLoader.js';
import { tp } from '../ui/utils/i18n.js';

/**
 * Bridges the real CLI slash-command set (the same {@link BuiltinCommandLoader}
 * the interactive TUI uses) onto the ACP transport so desktop/IDE clients can
 * both *discover* and *execute* commands that match the CLI.
 *
 * Two surfaces:
 *  - {@link buildAdvertisedCommands} — what the client shows in its `/` popup.
 *  - {@link dispatchCommand} — headless execution of a typed command.
 *
 * Commands fall into three buckets when executed over ACP:
 *  1. **Text output** — actions that push `ui.addItem({ text })` (e.g. `/tools`,
 *     `/skill list`). We relay that text straight to the client.
 *  2. **Prompt templates** — actions returning `{ type: 'submit_prompt' }`
 *     (e.g. `/ppt`, `/wiki`). We hand the expanded prompt back so the caller
 *     can run it through the model instead of skipping the turn.
 *  3. **Interactive-only** — dialogs/wizards/quit/etc. that only make sense in
 *     the CLI TUI. We answer with a localized notice instead of silently doing
 *     nothing.
 *
 * NOTE on bundling: this module statically imports {@link BuiltinCommandLoader}
 * (which pulls in the whole interactive UI command tree). That is only safe
 * because `yoga-layout` is marked `external` in `esbuild.config.js`. Yoga's
 * `index.js` does a genuine top-level `await` (WASM init); when it is bundled,
 * esbuild emits all of Ink's (densely circular) modules as `__esm(async …)` and
 * the entry top-level-awaits them — an init order that only *settles* for one
 * fragile module layout, so reaching this tree from the ACP graph reorders it
 * into an unsettled top-level await and the backend exits with code 13 before
 * the ACP server is up. Keeping yoga external makes Ink's modules synchronous,
 * which removes that whole class of init-order deadlock.
 */

/**
 * Commands that are inherently tied to the interactive CLI TUI. They are hidden
 * from the advertised list and answered with a notice if invoked over ACP, so
 * the desktop never surfaces a command that can only ever no-op there.
 */
export const ACP_INTERACTIVE_ONLY: ReadonlySet<string> = new Set<string>([
  'quit',
  'clear',
  'vim',
  'editor',
  'corgi',
  'copy',
  'ide',
  'auth',
  'login',
  'theme',
  'new',
  'restore',
]);

/**
 * Commands that only make sense in the CLI *terminal* runtime and would clash
 * with the desktop GUI's own surfaces. Unlike {@link ACP_INTERACTIVE_ONLY}
 * (TUI-only widgets that simply can't render headless), these are full features
 * the desktop already provides differently and must not be exposed at all over
 * ACP — neither advertised in the `/` popup nor runnable.
 *
 * `/feishu` (and its `/lark` twin) is the CLI Feishu *input gateway*: it turns
 * the terminal into a Feishu bot host. The desktop ships its own visual Feishu
 * configuration UI and is not an input gateway, so surfacing `/feishu` there is
 * confusing and conflicting. We keep it fully functional in the CLI — the only
 * place the gateway actually runs — and hide it from the desktop/ACP surface.
 *
 * Match on the command's canonical `name`; alias invocations (`/飞书`, `/Lark`)
 * resolve to the same `name` before this check, so they are covered too. Add
 * future terminal-only commands here rather than scattering ad-hoc `if`s.
 */
export const ACP_TERMINAL_ONLY_COMMANDS: ReadonlySet<string> =
  new Set<string>(['feishu', 'lark']);

export interface AcpCommandMeta {
  name: string;
  description: string;
}

export interface DispatchContext {
  config: Config | null;
  settings: LoadedSettings;
  sendMessage: (text: string) => Promise<void>;
}

export interface DispatchResult {
  /** Whether a command was matched and handled (skip the LLM round-trip). */
  handled: boolean;
  /**
   * When set, the command expanded into a prompt that should be run through the
   * model (a `submit_prompt` action). The caller feeds this to the LLM instead
   * of ending the turn.
   */
  submitPrompt?: string;
}

/**
 * Maps the loaded CLI commands to the flat `{ name, description }` shape the ACP
 * `available_commands_update` carries. Hidden and interactive-only commands are
 * dropped, and the list is sorted for stable client rendering.
 */
export function buildAdvertisedCommands(
  commands: SlashCommand[],
): AcpCommandMeta[] {
  return commands
    .filter(
      (c) =>
        !c.hidden &&
        !ACP_INTERACTIVE_ONLY.has(c.name) &&
        !ACP_TERMINAL_ONLY_COMMANDS.has(c.name),
    )
    .map((c) => ({ name: c.name, description: c.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Loads the real built-in command set. Not cached: `ideCommand`/`restoreCommand`
 * bind the per-session `config` at construction, and loading is cheap (no I/O).
 */
export async function loadRealCommands(
  config: Config | null,
): Promise<SlashCommand[]> {
  const loader = new BuiltinCommandLoader(config);
  return loader.loadCommands(new AbortController().signal);
}

/**
 * Walks the command tree to resolve `/foo bar args` into the deepest matching
 * command plus the trailing argument string. Mirrors the CLI's two-pass
 * (name → altName) resolution.
 */
function resolveCommand(
  commands: SlashCommand[],
  parts: string[],
): { command?: SlashCommand; args: string } {
  let level = commands;
  let command: SlashCommand | undefined;
  let pathIndex = 0;

  for (const part of parts) {
    const found =
      level.find((c) => c.name === part || c.altNames?.includes(part)) ??
      level.find(
        (c) =>
          c.name.toLowerCase() === part.toLowerCase() ||
          c.altNames?.some((a) => a.toLowerCase() === part.toLowerCase()),
      );
    if (!found) break;
    command = found;
    pathIndex++;
    if (found.subCommands && found.subCommands.length > 0) {
      level = found.subCommands;
    } else {
      break;
    }
  }

  return { command, args: parts.slice(pathIndex).join(' ') };
}

/**
 * Builds a minimal, headless {@link CliCommandContext}. UI side effects are
 * either relayed to the client (`addItem` → `sendMessage`) or no-ops. Anything a
 * command reaches for that we don't model throws and is caught by the caller,
 * surfacing as an error message rather than crashing the session.
 */
function makeHeadlessContext(
  ctx: DispatchContext,
  invocation: { raw: string; name: string; args: string },
): CliCommandContext {
  const relay = (item: { text?: string } | null | undefined) => {
    if (item && typeof item.text === 'string' && item.text.length > 0) {
      void ctx.sendMessage(item.text);
    }
  };

  return {
    invocation,
    services: {
      config: ctx.config,
      settings: ctx.settings,
      git: undefined as unknown as GitService | undefined,
      // No-op logger: the headless command surface never persists telemetry.
      logger: {
        initialize: async () => undefined,
        log: () => undefined,
        logMessage: () => undefined,
        getPreviousUserMessages: async () => [],
      } as unknown as Logger,
    },
    isNonInteractive: true,
    ui: {
      // addItem returns a history id (number) in the TUI; relay text instead.
      addItem: ((item: { text?: string }) => {
        relay(item);
        return 0;
      }) as unknown as CliCommandContext['ui']['addItem'],
      clear: () => undefined,
      setDebugMessage: () => undefined,
      pendingItem: null,
      setPendingItem: () => undefined,
      loadHistory: (() =>
        undefined) as unknown as CliCommandContext['ui']['loadHistory'],
      toggleCorgiMode: () => undefined,
      toggleVimEnabled: async () => false,
      debugMessages: [],
    },
    session: {
      stats: {} as CliCommandContext['session']['stats'],
      cumulativeCredits: 0,
      totalSessionCredits: 0,
      lastTokenUsage: null,
    },
  };
}

/**
 * Executes a typed slash command against an already-loaded command list.
 * Pure of any I/O beyond what the command itself does, so it is unit-testable
 * with a hand-rolled command list.
 */
export async function dispatchCommand(
  commands: SlashCommand[],
  commandText: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const trimmed = commandText.trim();
  const stripped =
    trimmed.startsWith('/') || trimmed.startsWith('$')
      ? trimmed.slice(1).trim()
      : trimmed;
  const parts = stripped.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { handled: false };

  const { command, args } = resolveCommand(commands, parts);
  if (!command) return { handled: false };

  // Terminal-only commands (e.g. the Feishu input gateway) are not exposed to
  // desktop/ACP clients — refuse to run them even if typed manually. Match on
  // the canonical name, which also covers alias forms (`/飞书`, `/Lark`).
  if (ACP_TERMINAL_ONLY_COMMANDS.has(command.name)) {
    await ctx.sendMessage(
      tp('acp.command.terminalOnly', { name: command.name }),
    );
    return { handled: true };
  }

  // Interactive-only commands (and pure parent groups with no action) can't run
  // headless — surface an honest notice rather than a silent no-op.
  if (ACP_INTERACTIVE_ONLY.has(command.name) || !command.action) {
    await ctx.sendMessage(
      tp('acp.command.interactiveOnly', { name: command.name }),
    );
    return { handled: true };
  }

  try {
    const result = (await command.action(
      makeHeadlessContext(ctx, {
        raw: commandText,
        name: command.name,
        args,
      }),
      args,
    )) as SlashCommandActionReturn | void;

    if (result && typeof result === 'object' && 'type' in result) {
      switch (result.type) {
        case 'submit_prompt':
          return { handled: true, submitPrompt: result.content };
        case 'message':
          await ctx.sendMessage(result.content);
          return { handled: true };
        default:
          // dialog / quit / tool / load_history / switch_session /
          // select_session / refine_result — all need the interactive TUI.
          await ctx.sendMessage(
            tp('acp.command.interactiveOnly', { name: command.name }),
          );
          return { handled: true };
      }
    }

    // A void return means the command already relayed its output via addItem.
    return { handled: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.sendMessage(`Error: ${msg}`);
    return { handled: true };
  }
}

/**
 * Loads the real command set and dispatches `commandText` against it.
 * Returns `{ handled: false }` if no command matched (caller falls back to LLM).
 */
export async function runRealCommand(
  commandText: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  let commands: SlashCommand[];
  try {
    commands = await loadRealCommands(ctx.config);
  } catch {
    // Loading the CLI command tree failed (e.g. an incomplete config). Treat as
    // "no command matched" so the caller falls back to the normal LLM path.
    return { handled: false };
  }
  return dispatchCommand(commands, commandText, ctx);
}
