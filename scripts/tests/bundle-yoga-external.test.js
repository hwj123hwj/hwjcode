/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

/**
 * Regression guard for the `--acp` backend "code 13" startup crash.
 *
 * `yoga-layout`'s entry does a genuine top-level `await` (WASM init). When
 * esbuild BUNDLES it, every (densely circular) Ink module that imports it is
 * emitted as an `__esm(async …)` initializer and the bundle entry
 * top-level-awaits the whole graph — an init order that only *settles* for one
 * fragile module layout. Any new module reachable from the ACP command path
 * (e.g. `acpCommandBridge` → `BuiltinCommandLoader` → the UI command tree)
 * reorders it into an *unsettled* top-level await, and the spawned backend
 * exits with code 13 before the ACP server is up ("Easy Code 后端在初始化前退出").
 *
 * The fix marks `yoga-layout` as `external` in esbuild.config.js (so Ink's
 * modules stay synchronous) and ships it into `bundle/node_modules` via
 * copy_bundle_assets.js so Node can resolve it next to `easycode.js` at runtime.
 * Both halves are required; this test fails loudly if either regresses.
 */
describe('yoga-layout externalization (acp code-13 guard)', () => {
  it('esbuild marks yoga-layout as external', () => {
    const cfg = readFileSync(resolve(root, 'esbuild.config.js'), 'utf8');
    // The `external: [...]` array must contain 'yoga-layout'.
    const match = cfg.match(/external:\s*\[([^\]]*)\]/);
    expect(match, 'esbuild.config.js has an external: [...] array').toBeTruthy();
    expect(match[1]).toContain('yoga-layout');
  });

  it('copy_bundle_assets ships yoga-layout into the bundle node_modules', () => {
    const copy = readFileSync(
      resolve(root, 'scripts', 'copy_bundle_assets.js'),
      'utf8',
    );
    expect(copy).toContain('yoga-layout');
    expect(copy).toContain("'node_modules', 'yoga-layout'");
  });

  it('produces a runnable yoga-layout in bundle/node_modules when built', () => {
    const yogaEntry = resolve(
      root,
      'bundle',
      'node_modules',
      'yoga-layout',
      'dist',
      'src',
      'index.js',
    );
    if (!existsSync(resolve(root, 'bundle', 'easycode.js'))) {
      // No bundle built in this environment — nothing to assert.
      return;
    }
    expect(
      existsSync(yogaEntry),
      'bundle/node_modules/yoga-layout/dist/src/index.js must exist next to easycode.js',
    ).toBe(true);
  });
});
