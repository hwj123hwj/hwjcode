/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type CustomModelConfig,
  type ThinkingConfig,
  type ToolResult,
  type ToolCallConfirmationDetails,
  type ToolConfirmationPayload,
  Kind,
  Icon,
  ApprovalMode,
  ToolConfirmationOutcome,
  fetchCloudModels,
  tokenLimit,
  generateCustomModelId,
} from 'deepv-code-core';
import type * as acp from '@agentclientprotocol/sdk';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { z } from 'zod';
import { SettingScope, type LoadedSettings } from '../config/settings.js';
import { loadCustomModels } from '../config/customModelsStorage.js';
import { formatCustomModelDisplayName } from '../utils/modelUtils.js';

/**
 * Collect the user's enabled custom models (from `~/.easycode-user/
 * custom-models.json`, falling back to whatever `Config` loaded at startup) as
 * `{ modelId, name }` pairs ready to drop into the ACP model list.
 *
 * The interactive CLI surfaces custom models in its `/model` picker
 * ({@link getAvailableModels}); ACP clients (the desktop app, IDEs) must see
 * the same set or custom models become unselectable there.
 */
function customModelEntries(
  config: Config,
): Array<{ modelId: string; name: string }> {
  let models: CustomModelConfig[] = [];
  try {
    models = loadCustomModels();
  } catch {
    models = [];
  }
  // Fall back to the config snapshot loaded at startup if the file read came
  // back empty (e.g. permissions) but config still has them.
  if (models.length === 0) {
    try {
      models = config.getCustomModels?.() ?? [];
    } catch {
      models = [];
    }
  }
  const entries: Array<{ modelId: string; name: string }> = [];
  for (const m of models) {
    if (m?.enabled === false) continue;
    if (!m?.displayName || !m?.modelId || !m?.baseUrl) continue;
    entries.push({
      modelId: generateCustomModelId(m),
      name: formatCustomModelDisplayName(m),
    });
  }
  return entries;
}

/**
 * Build the `session/update` payload for `sessionUpdate: 'usage_update'`.
 *
 * `UsageUpdate` is marked UNSTABLE in the ACP SDK schema (see
 * `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` —
 * `UsageUpdate`), but the wire shape is stable: `{ used, size, cost? }`.
 *
 *   - `used`  — total tokens currently in the chat's context window for the
 *               most recent turn. Pulled from the model's `usageMetadata`
 *               via {@link GeminiChat.getFinalUsageMetadata}.
 *   - `size`  — total context window of the *currently selected* model,
 *               resolved through {@link tokenLimit} (server-authoritative
 *               via `Config.getCloudModelInfo`).
 *
 * Returns `null` when neither token count nor a model is known yet — caller
 * should skip emitting in that case so the IDE keeps showing its previous
 * estimate instead of flickering to 0/0.
 */
export function buildUsageUpdate(
  usage: GenerateContentResponseUsageMetadata | undefined,
  config: Config,
): acp.SessionUpdate | null {
  // The Gemini SDK reports usage in slightly different fields depending on
  // backend (Gemini vs proxy-Claude). `totalTokenCount` is the canonical
  // "what's currently being billed for this turn"; fall back to the sum
  // when the proxy only reports the split.
  const used =
    usage?.totalTokenCount ??
    ((usage?.promptTokenCount ?? 0) + (usage?.candidatesTokenCount ?? 0));
  if (!used) return null;

  const model = config.getModel?.() ?? 'auto';
  const size = tokenLimit(model, config);
  if (!size) return null;

  return {
    sessionUpdate: 'usage_update',
    used,
    size,
  } as acp.SessionUpdate;
}

/** Type guard: does `obj` carry a `_meta` field (per ACP spec)? */
export function hasMeta(
  obj: unknown,
): obj is { _meta?: Record<string, unknown> } {
  return typeof obj === 'object' && obj !== null && '_meta' in obj;
}

/**
 * The answer payload an interactive ACP client (the desktop app) returns for
 * an {@link AskUserQuestionTool} prompt, carried inside the `_meta.dvcode`
 * channel of the {@link acp.Client.requestPermission} response (the base ACP
 * `requestPermission` contract only models `optionId`, so there is no first-
 * class field for free-form answers). Mirrors {@link ToolConfirmationPayload}.
 */
const AskAnswersMetaSchema = z
  .object({
    answers: z.record(z.string()).optional(),
    annotations: z
      .record(
        z.object({
          preview: z.string().optional(),
          notes: z.string().optional(),
        }),
      )
      .optional(),
    feedback: z.string().optional(),
  })
  .optional();

/**
 * Zod schema for the response to {@link acp.Client.requestPermission}.
 * ACP clients reply with either `{outcome: 'cancelled'}` or
 * `{outcome: 'selected', optionId: '...'}`.
 *
 * For `ask_user_question` the client additionally tucks the collected answers
 * into `_meta.dvcode` (see {@link AskAnswersMetaSchema}); we parse it
 * leniently so non-question tools (which never send it) are unaffected.
 */
export const RequestPermissionResponseSchema = z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('cancelled') }),
    z.object({
      outcome: z.literal('selected'),
      optionId: z.string(),
    }),
  ]),
  _meta: z
    .object({ dvcode: AskAnswersMetaSchema })
    .passthrough()
    .optional(),
});

/**
 * Pull the AskUserQuestion answer payload out of a parsed
 * {@link RequestPermissionResponseSchema} result. Returns `undefined` for
 * ordinary tool approvals (no answers attached), so callers can pass it
 * straight through to `confirmation.onConfirm(outcome, payload)`.
 */
export function extractAskAnswers(
  parsed: z.infer<typeof RequestPermissionResponseSchema>,
): ToolConfirmationPayload | undefined {
  const dvcode = parsed._meta?.dvcode;
  if (!dvcode) return undefined;
  const { answers, annotations, feedback } = dvcode;
  if (!answers && !annotations && !feedback) return undefined;
  return {
    ...(answers ? { answers } : {}),
    ...(annotations ? { annotations } : {}),
    ...(feedback ? { feedback } : {}),
  };
}

/**
 * Map an internal {@link ToolResult} to the wire shape expected in
 * `session/update#tool_call` `content` fields.
 *
 * Returns `null` when the tool produced no user-visible output (e.g. a pure
 * background side-effect) — callers should then omit `content` entirely.
 */
export function toToolCallContent(
  toolResult: ToolResult,
): acp.ToolCallContent | null {
  if (toolResult.returnDisplay) {
    if (typeof toolResult.returnDisplay === 'string') {
      return {
        type: 'content',
        content: { type: 'text', text: toolResult.returnDisplay },
      };
    }
    if ('fileName' in toolResult.returnDisplay) {
      const display = toolResult.returnDisplay as {
        fileName: string;
        filePath?: string;
        originalContent?: string;
        newContent: string;
      };
      const oldText = display.originalContent ?? '';
      const newText = display.newContent ?? '';
      const kind = !oldText ? 'add' : newText === '' ? 'delete' : 'modify';
      return {
        type: 'diff',
        path: display.filePath ?? display.fileName,
        oldText,
        newText,
        _meta: { kind },
      };
    }
  }
  return null;
}

const basicPermissionOptions: acp.PermissionOption[] = [
  {
    optionId: ToolConfirmationOutcome.ProceedOnce,
    name: 'Allow',
    kind: 'allow_once',
  },
  {
    optionId: ToolConfirmationOutcome.Cancel,
    name: 'Reject',
    kind: 'reject_once',
  },
];

/**
 * Build the `PermissionOption[]` array sent to the IDE when a tool call
 * needs user approval. Mirrors gemini-cli's logic: the "always allow"
 * variants are produced for tool kinds that support them (edit/exec/mcp/
 * info) and suppressed for `ask_user` / plan-mode exits.
 *
 * DeepCode's `Config` does not currently expose `getDisableAlwaysAllow`, so
 * the flag is queried via duck-typing and defaults to `false`.
 */
export function toPermissionOptions(
  confirmation: ToolCallConfirmationDetails,
  config: Config,
  enablePermanentToolApproval = false,
): acp.PermissionOption[] {
  const cfg = config as unknown as { getDisableAlwaysAllow?: () => boolean };
  const disableAlwaysAllow = cfg.getDisableAlwaysAllow?.() ?? false;
  const options: acp.PermissionOption[] = [];

  if (!disableAlwaysAllow) {
    switch (confirmation.type) {
      case 'edit':
        options.push({
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Allow for this session',
          kind: 'allow_always',
        });
        if (enablePermanentToolApproval) {
          options.push({
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Allow for this file in all future sessions',
            kind: 'allow_always',
          });
        }
        break;
      case 'exec':
        options.push({
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Allow for this session',
          kind: 'allow_always',
        });
        if (enablePermanentToolApproval) {
          options.push({
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Allow this command for all future sessions',
            kind: 'allow_always',
          });
        }
        break;
      case 'mcp':
        options.push(
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysServer,
            name: 'Allow all server tools for this session',
            kind: 'allow_always',
          },
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysTool,
            name: 'Allow tool for this session',
            kind: 'allow_always',
          },
        );
        if (enablePermanentToolApproval) {
          options.push({
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Allow tool for all future sessions',
            kind: 'allow_always',
          });
        }
        break;
      case 'info':
        options.push({
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Allow for this session',
          kind: 'allow_always',
        });
        if (enablePermanentToolApproval) {
          options.push({
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Allow for all future sessions',
            kind: 'allow_always',
          });
        }
        break;
      default:
        // ask_user / exit_plan_mode / unknown: only basic options.
        break;
    }
  }
  options.push(...basicPermissionOptions);
  return options;
}

/**
 * Build the `_meta.dvcode` payload to attach to a `requestPermission` request
 * for an {@link AskUserQuestionTool} prompt. The base ACP `requestPermission`
 * contract only carries Allow/Reject options, so the actual questions (with
 * their options/previews/multiSelect) are forwarded out-of-band here for
 * interactive clients (the desktop app) to render. Returns `undefined` for any
 * non-question confirmation so ordinary tool approvals stay untouched.
 */
export function questionMetaFor(
  confirmation: ToolCallConfirmationDetails,
): Record<string, unknown> | undefined {
  if (confirmation.type !== 'question') return undefined;
  return {
    dvcode: {
      askUserQuestion: {
        questions: confirmation.questions,
        ...(confirmation.metadata ? { metadata: confirmation.metadata } : {}),
      },
    },
  };
}

/**
 * Decide whether an ACP caller (the upstream agent) should be asked to
 * approve this tool call, or whether the dvcode ACP runtime can silently
 * proceed.
 *
 * Rationale: ACP is agent-to-agent. The TUI equivalent is YOLO mode, which
 * auto-runs routine edits/writes/shell commands but still hard-stops on
 * dangerous shell invocations, destructive file deletes, and explicit
 * `ask_user_question` calls. We mirror that split here:
 *
 *   - `question`            — always needs approval; only a real user can
 *                             meaningfully answer a multiple-choice question.
 *   - `exec` with `warning` — dangerous-command-detector matched; refuse
 *                             to run silently even under YOLO.
 *   - `delete`              — irreversible file removal.
 *   - everything else       — proceed automatically (ProceedOnce).
 *
 * Unknown confirmation shapes default to "needs approval" (safe fallback).
 */
export function confirmationRequiresCallerApproval(
  confirmation: ToolCallConfirmationDetails,
): boolean {
  switch (confirmation.type) {
    case 'question':
      return true;
    case 'exec':
      return Boolean((confirmation as { warning?: string }).warning);
    case 'delete':
      return true;
    case 'edit':
    case 'mcp':
    case 'info':
      return false;
    default:
      return true;
  }
}

/**
 * Map DeepCode's {@link Kind} to the ACP `ToolKind` wire type.
 *
 * Several kinds that have no exact ACP counterpart (`Agent`, `Plan`,
 * `Communicate`, `SwitchMode`) are folded into `'other'` / `'think'`.
 */
/**
 * Derive the ACP `ToolKind` from a tool's {@link Icon}.
 *
 * DeepCode's core tools don't carry a {@link Kind} on the instance (only an
 * `icon`), so the ACP agent has no semantic kind to forward — every tool would
 * otherwise fall back to `'other'`, and ACP clients (the desktop app, IDEs)
 * would render them all with the same generic wrench icon. The `Icon` enum is a
 * required constructor field on every tool, so it's a reliable proxy for the
 * tool's intent; map it onto the closest ACP kind so clients can pick a
 * per-tool icon. Unknown/ambiguous icons fall back to `'other'`.
 */
export function iconToAcpKind(icon: Icon | undefined): acp.ToolKind {
  switch (icon) {
    case Icon.Pencil:
    case Icon.Wrench: // LintFix edits files
      return 'edit' as acp.ToolKind;
    case Icon.Trash:
      return 'delete' as acp.ToolKind;
    case Icon.Terminal:
      return 'execute' as acp.ToolKind;
    case Icon.FileSearch:
    case Icon.Regex:
    case Icon.Folder:
      return 'search' as acp.ToolKind;
    case Icon.Globe:
      return 'fetch' as acp.ToolKind;
    case Icon.LightBulb:
      return 'think' as acp.ToolKind;
    case Icon.Clipboard: // TodoRead
    case Icon.List: // ListSkills
    case Icon.Info: // GetSkillDetails
      return 'read' as acp.ToolKind;
    case Icon.Hammer:
    case Icon.Tasks: // TodoWrite
    case Icon.Question: // AskUserQuestion
    default:
      return 'other' as acp.ToolKind;
  }
}

export function toAcpToolKind(kind: Kind): acp.ToolKind {
  switch (kind) {
    case Kind.Read:
    case Kind.Edit:
    case Kind.Execute:
    case Kind.Search:
    case Kind.Delete:
    case Kind.Move:
    case Kind.Think:
    case Kind.Fetch:
    case Kind.Other:
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return kind as unknown as acp.ToolKind;
    case Kind.Agent:
      return 'think' as acp.ToolKind;
    case Kind.Plan:
    case Kind.Communicate:
    case Kind.SwitchMode:
    default:
      return 'other' as acp.ToolKind;
  }
}

/**
 * Build the list of session modes announced to the IDE.
 *
 * DeepCode's {@link ApprovalMode} enum does not include a `PLAN` variant
 * (gemini-cli ships one behind a flag), so the `isPlanEnabled` parameter is
 * accepted for API compatibility but currently has no effect.
 */
export function buildAvailableModes(
  _isPlanEnabled: boolean = false,
): acp.SessionMode[] {
  return [
    {
      id: ApprovalMode.DEFAULT,
      name: 'Default',
      description: 'Prompts for approval',
    },
    {
      id: ApprovalMode.AUTO_EDIT,
      name: 'Auto Edit',
      description: 'Auto-approves edit tools',
    },
    {
      id: ApprovalMode.YOLO,
      name: 'YOLO',
      description: 'Auto-approves all tools',
    },
  ];
}

/**
 * Build the list of models surfaced to the IDE for session-model switching.
 *
 * Pulls the authoritative list from `Config.getCloudModels()` (populated by
 * the proxy's `/web-api/models` endpoint — same source the interactive CLI
 * uses for `/model`). Always prepends `auto` and guarantees the currently
 * selected model is present, even when it's not in the cloud catalogue.
 */
export function buildAvailableModels(
  config: Config,
  _settings: LoadedSettings,
): {
  availableModels: Array<{
    modelId: string;
    name: string;
    description?: string;
  }>;
  currentModelId: string;
} {
  const current = config.getModel?.() ?? 'auto';
  const preferred = config.getPreferredModel?.() ?? current;
  const cloudModels = config.getCloudModels?.() ?? [];
  const seen = new Set<string>();
  const models: Array<{
    modelId: string;
    name: string;
    description?: string;
  }> = [];

  // 1) `auto` is always first — it's the server-pick default.
  models.push({
    modelId: 'auto',
    name: 'Auto',
    description: 'Server-selected model',
  });
  seen.add('auto');

  // 2) Whatever the cloud says is available.
  for (const m of cloudModels) {
    if (!m?.name || seen.has(m.name)) continue;
    if (m.available === false) continue;
    seen.add(m.name);
    models.push({ modelId: m.name, name: m.displayName || m.name });
  }

  // 3) User-configured custom models (~/.easycode-user/custom-models.json),
  //    so the desktop/IDE model picker can select them just like the CLI.
  for (const entry of customModelEntries(config)) {
    if (seen.has(entry.modelId)) continue;
    seen.add(entry.modelId);
    models.push(entry);
  }

  // 4) Make sure the currently-selected and preferred ids are visible even
  //    if they're not in the cloud list (user just switched to one via /model,
  //    cache empty on first run, etc.).
  for (const id of [preferred, current]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ modelId: id, name: id });
  }

  return { availableModels: models, currentModelId: current };
}

/**
 * Model ids we always advertise in the `configOptions[id="model"]` selector.
 *
 * DeepCode resolves the final model server-side, so the client-visible list
 * is short and curated rather than dynamically fetched. The `"auto"` entry
 * keeps the legacy server-decides behavior. Every id in this list is
 * accepted by `Config.setModel` without validation (the proxy will reject
 * at call time if the underlying account doesn't have access).
 */
/**
 * Fallback model ids when the server-provided list isn't available yet
 * (e.g. first ACP session before /web-api/models has been fetched, or
 * offline-ish scenarios). Only entries here that the proxy actually
 * accepts will work; kept intentionally minimal to avoid surfacing
 * decommissioned ids (we hit this exact bug with an outdated
 * `claude-sonnet-4-5`).
 */
const FALLBACK_MODEL_IDS: Array<{
  value: string;
  name: string;
  description?: string;
}> = [
  { value: 'auto', name: 'Auto', description: 'Server-selected model' },
];

/**
 * Canonical single-string encoding of {@link ThinkingConfig} used by the
 * `thinking` ACP config option. Mirrors the `/thinking` CLI subcommands so the
 * desktop/IDE picker and the interactive CLI agree on the same vocabulary:
 *   - `off`  → thinking disabled (`{mode:'off'}`)
 *   - `auto` → provider/model default (`{mode:'auto'}`)
 *   - low|medium|high|xhigh|max → thinking on at that effort (`{mode:'on'}`)
 */
export const THINKING_OPTION_VALUES = [
  'off',
  'auto',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ThinkingOptionValue = (typeof THINKING_OPTION_VALUES)[number];

/** Collapse a {@link ThinkingConfig} to its single-string option value. */
export function thinkingConfigToOptionValue(
  cfg: ThinkingConfig | undefined,
): ThinkingOptionValue {
  if (!cfg || cfg.mode === 'auto') return 'auto';
  if (cfg.mode === 'off') return 'off';
  // mode === 'on' → reflect the effort. Default to 'high' to match the hidden
  // `/thinking on` shortcut, which enables high-effort thinking.
  const effort = cfg.effort;
  if (
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh' ||
    effort === 'max'
  ) {
    return effort;
  }
  return 'high';
}

/** Expand a single-string option value back to a {@link ThinkingConfig}. */
export function optionValueToThinkingConfig(value: string): ThinkingConfig {
  switch (value) {
    case 'off':
      return { mode: 'off', effort: 'auto' };
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return { mode: 'on', effort: value };
    case 'auto':
    default:
      return { mode: 'auto', effort: 'auto' };
  }
}

/**
 * Snapshot the full `configOptions[]` array a client should see right now.
 *
 * The shape matches ACP's `SessionConfigOption`. We currently expose:
 *   - `model` (select): switches the LLM.
 *   - `thinking` (select): extended-thinking mode / reasoning effort.
 *
 * The model list is pulled from `Config.getCloudModels()` — the authoritative
 * list that the proxy server provides via `/web-api/models`. When that cache
 * is empty (first run, no prior `/model` invocation, etc.) we fall back to
 * showing just `auto` + whatever model `Config.getModel()` currently reports,
 * so the IDE has at least one valid choice.
 *
 * When DeepCode ships more per-session knobs (thought level, turn timeout,
 * etc.) just add them here and to `Session.applyConfigOption`.
 */
export function buildConfigOptionsSnapshot(
  config: Config,
  overrides: ReadonlyMap<string, string | boolean>,
): acp.SessionConfigOption[] {
  const currentModel =
    (overrides.get('model') as string | undefined) ??
    config.getModel?.() ??
    'auto';

  const cloudModels = config.getCloudModels?.() ?? [];
  const seen = new Set<string>();
  const options: Array<{ value: string; name: string; description?: string }> = [];

  for (const entry of FALLBACK_MODEL_IDS) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    options.push(entry);
  }
  for (const m of cloudModels) {
    if (!m?.name || seen.has(m.name)) continue;
    if (m.available === false) continue;
    seen.add(m.name);
    options.push({
      value: m.name,
      name: m.displayName || m.name,
    });
  }
  // User-configured custom models (~/.easycode-user/custom-models.json).
  for (const entry of customModelEntries(config)) {
    if (seen.has(entry.modelId)) continue;
    seen.add(entry.modelId);
    options.push({ value: entry.modelId, name: entry.name });
  }
  // Ensure the currently-selected model is in the list even if it's not
  // marked available (server just rolled it back, user got it via /model,
  // etc.). Without this, ACP clients may refuse the snapshot.
  if (currentModel && !seen.has(currentModel)) {
    seen.add(currentModel);
    options.push({ value: currentModel, name: currentModel });
  }

  const modelOption: acp.SessionConfigOption = {
    id: 'model',
    type: 'select',
    name: 'Model',
    description: 'LLM used for this session',
    category: 'model',
    currentValue: currentModel,
    options: options.map((o) => ({
      value: o.value,
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
    })),
  };

  const thinkingValue =
    (overrides.get('thinking') as string | undefined) ??
    thinkingConfigToOptionValue(config.getThinkingConfig?.());
  const thinkingOption: acp.SessionConfigOption = {
    id: 'thinking',
    type: 'select',
    name: 'Thinking',
    description: 'Extended thinking mode and reasoning effort',
    category: 'thought_level',
    currentValue: thinkingValue,
    options: [
      { value: 'off', name: 'Off' },
      { value: 'auto', name: 'Auto' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'X-High' },
      { value: 'max', name: 'Max' },
    ],
  };

  return [modelOption, thinkingOption];
}

/**
 * Fetch the authoritative list of models the proxy will accept and seed
 * `Config.setCloudModels` with it, then persist it to the user settings cache.
 *
 * The interactive CLI does this lazily, on the first `/model` invocation, and
 * persists to `settings.json` via `saveCloudModelsToSettings`. ACP clients (the
 * desktop app, IDEs) never fire `/model` — they read the model list straight
 * out of the `session/new` / `session/load` response, exactly once. So without
 * this preload the ACP agent advertises an empty/fallback list and a
 * desktop-only user (who never ran the interactive CLI, hence has no cached
 * `cloudModels`) sees no models at all.
 *
 * The actual network fetch/parse is shared with the CLI via core's
 * {@link fetchCloudModels} — same `/web-api/models` endpoint, same auth headers.
 * Passing `settings` writes the result through to `settings.json` so the NEXT
 * cold start is warm (the CLI behaves identically).
 *
 * Best-effort: network/auth failures here are logged but never fatal. Without
 * the cache, the snapshot falls back to `auto` + the current model.
 */
export async function refreshCloudModelsForAcp(
  config: Config,
  settings?: LoadedSettings,
): Promise<void> {
  if (!config.setCloudModels) return;
  try {
    const models = await fetchCloudModels({ userAgent: 'DeepCode ACP' });
    config.setCloudModels(models);

    // Mirror the interactive CLI's saveCloudModelsToSettings: persist to the
    // user settings.json so the next desktop/ACP launch starts warm and
    // `buildAvailableModels` can advertise the full list synchronously.
    if (settings) {
      try {
        settings.setValue(SettingScope.User, 'cloudModels', models);
      } catch (e) {
        process.stderr.write(
          `[acp] failed to persist cloud models to settings: ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
      }
    }

    process.stderr.write(
      `[acp] loaded ${models.length} models from /web-api/models\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[acp] model-list preload failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
