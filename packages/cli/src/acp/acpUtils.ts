/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type ToolResult,
  type ToolCallConfirmationDetails,
  Kind,
  ApprovalMode,
  ToolConfirmationOutcome,
} from 'deepv-code-core';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { LoadedSettings } from '../config/settings.js';

/** Type guard: does `obj` carry a `_meta` field (per ACP spec)? */
export function hasMeta(
  obj: unknown,
): obj is { _meta?: Record<string, unknown> } {
  return typeof obj === 'object' && obj !== null && '_meta' in obj;
}

/**
 * Zod schema for the response to {@link acp.Client.requestPermission}.
 * ACP clients reply with either `{outcome: 'cancelled'}` or
 * `{outcome: 'selected', optionId: '...'}`.
 */
export const RequestPermissionResponseSchema = z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('cancelled') }),
    z.object({
      outcome: z.literal('selected'),
      optionId: z.string(),
    }),
  ]),
});

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
 * Map DeepCode's {@link Kind} to the ACP `ToolKind` wire type.
 *
 * Several kinds that have no exact ACP counterpart (`Agent`, `Plan`,
 * `Communicate`, `SwitchMode`) are folded into `'other'` / `'think'`.
 */
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
 * DeepCode resolves the concrete model server-side (`'auto'` is the common
 * default). We return the preferred model as a single entry so the IDE still
 * has something meaningful to display, while leaving room for the runtime
 * to expose a richer catalog later.
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
  const seen = new Set<string>();
  const models: Array<{
    modelId: string;
    name: string;
    description?: string;
  }> = [];
  for (const id of [preferred, current]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      modelId: id,
      name: id,
      description: id === 'auto' ? 'Server-selected model' : undefined,
    });
  }
  return { availableModels: models, currentModelId: current };
}
