/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the main-process pure-logic unit tests. These import no Electron /
    // child_process surface, so a plain node environment is enough.
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/out/**', '**/dist/**'],
    environment: 'node',
    globals: true,
  },
});
