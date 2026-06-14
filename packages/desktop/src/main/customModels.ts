/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Custom-model management for the desktop app.
 *
 * Custom models live in the same shared store the CLI uses —
 * `~/.easycode-user/custom-models.json` — so a model added here is visible to
 * the CLI and to every spawned `easycode --acp` backend (which loads the file
 * on startup and now advertises custom models in its ACP model list). This
 * mirrors `packages/cli/src/config/customModelsStorage.ts` but stands alone so
 * the main process doesn't drag in the CLI package.
 *
 * Deep import (not the barrel) keeps the heavy `deepv-code-core` index out of
 * the main process — same rationale as `auth.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import {
  type CustomModelConfig,
  validateCustomModelConfig,
  generateCustomModelId,
} from 'deepv-code-core/dist/src/types/customModel.js';
import type {
  CustomModelEntry,
  CustomModelInput,
  CustomModelProvider,
  SaveCustomModelResult,
} from '../shared/ipc.js';

const SETTINGS_DIRECTORY_NAME = '.easycode-user';
const CUSTOM_MODELS_FILE = 'custom-models.json';

function filePath(): string {
  return path.join(homedir(), SETTINGS_DIRECTORY_NAME, CUSTOM_MODELS_FILE);
}

function providerLabel(provider: CustomModelProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'openai-responses':
      return 'OpenAI Responses';
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Gemini';
    default:
      return provider;
  }
}

/** Read raw configs from disk; never throws (returns [] on any failure). */
function readModels(): CustomModelConfig[] {
  try {
    const fp = filePath();
    if (!fs.existsSync(fp)) return [];
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return Array.isArray(parsed?.models) ? (parsed.models as CustomModelConfig[]) : [];
  } catch (err) {
    console.warn('[customModels] Failed to read custom-models.json:', err);
    return [];
  }
}

/** Atomic write (temp file + rename), matching the CLI's storage. */
function writeModels(models: CustomModelConfig[]): void {
  const fp = filePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const data = {
    models,
    _metadata: { version: '1.0', lastModified: new Date().toISOString() },
  };
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
}

function toEntry(m: CustomModelConfig): CustomModelEntry {
  return {
    displayName: m.displayName,
    provider: m.provider as CustomModelProvider,
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    modelId: m.modelId,
    maxTokens: m.maxTokens,
    enabled: m.enabled !== false,
    id: generateCustomModelId(m),
    label: `[${providerLabel(m.provider as CustomModelProvider)}] ${m.displayName}`,
  };
}

/** List the user's custom models, enriched with the generated id + label. */
export function listCustomModels(): CustomModelEntry[] {
  return readModels().map(toEntry);
}

/**
 * Add or update a custom model (keyed by `displayName`). When editing renames
 * the model, pass the previous name as `originalDisplayName` so the old entry
 * is replaced rather than orphaned.
 */
export function saveCustomModel(
  input: CustomModelInput,
  originalDisplayName?: string,
): SaveCustomModelResult {
  const model: CustomModelConfig = {
    displayName: input.displayName?.trim() ?? '',
    provider: input.provider,
    baseUrl: input.baseUrl?.trim() ?? '',
    apiKey: input.apiKey?.trim() ?? '',
    modelId: input.modelId?.trim() ?? '',
    ...(typeof input.maxTokens === 'number' && input.maxTokens > 0
      ? { maxTokens: input.maxTokens }
      : {}),
    enabled: input.enabled !== false,
  };

  const errors = validateCustomModelConfig(model);
  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') };
  }

  try {
    const models = readModels();
    const prevName = originalDisplayName?.trim() || model.displayName;
    const idx = models.findIndex((m) => m.displayName === prevName);
    if (idx >= 0) {
      models[idx] = model;
    } else {
      // Guard against a duplicate displayName when adding a brand-new model.
      const dup = models.findIndex((m) => m.displayName === model.displayName);
      if (dup >= 0) models[dup] = model;
      else models.push(model);
    }
    writeModels(models);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a custom model by its `displayName`. */
export function deleteCustomModel(displayName: string): void {
  const name = displayName?.trim();
  if (!name) return;
  const models = readModels();
  const next = models.filter((m) => m.displayName !== name);
  if (next.length !== models.length) writeModels(next);
}
