/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// diff@8 renamed PatchOptions → CreatePatchOptionsNonabortable (and split into
// abortable/non-abortable variants).  Use an inline type to stay version-agnostic.
export interface DiffOptions {
  context?: number;
  ignoreWhitespace?: boolean;
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  context: 3,
  ignoreWhitespace: true,
};
