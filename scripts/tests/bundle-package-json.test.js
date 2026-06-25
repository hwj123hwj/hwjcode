/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

/**
 * Regression guard for the 1.1.26 update-check breakage.
 *
 * `scripts/copy_bundle_assets.js` writes `bundle/package.json` so the bundle is
 * self-describing as ESM once copied out of the repo. In 1.1.26 it shipped only
 * `{ "type": "module" }` — with no `name`/`version`. Because the CLI resolves
 * its own identity via `readPackageUp()` walking up from the bundle dir, the
 * stripped package.json made the update-check user-agent degrade to "/" and
 * `checkForUpdates` bailed out silently. The bundle's package.json MUST carry a
 * real name and version.
 *
 * This test only runs once a bundle has been produced (i.e. after `npm run
 * bundle`/`pack`); it is skipped on a clean checkout so it never blocks unit
 * runs that don't build the bundle.
 */
describe('bundle/package.json contract', () => {
  const bundlePkgPath = resolve(root, 'bundle', 'package.json');

  it('carries name, version and type=module when the bundle exists', () => {
    if (!existsSync(bundlePkgPath)) {
      // No bundle built in this environment — nothing to assert.
      return;
    }

    const pkg = JSON.parse(readFileSync(bundlePkgPath, 'utf8'));

    expect(pkg.type).toBe('module');
    expect(typeof pkg.name).toBe('string');
    expect(pkg.name.length).toBeGreaterThan(0);
    expect(typeof pkg.version).toBe('string');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);

    // The name must match the CLI package so the update-check user-agent is
    // correct (`<name>/<version>`), not the root or some unrelated package.
    const cliPkg = JSON.parse(
      readFileSync(resolve(root, 'packages', 'cli', 'package.json'), 'utf8'),
    );
    expect(pkg.name).toBe(cliPkg.name);
  });
});
