/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * electron-builder wrapper that works around the monorepo `file:` dependency.
 *
 * `deepv-code-core` is declared as `file:../core`, so npm links it as a symlink/
 * junction pointing at `packages/core`. With workspaces it is hoisted, so the link
 * lives at the REPO-ROOT `node_modules/deepv-code-core` (not under packages/desktop).
 * electron-builder resolves the dep through that link to its real path while
 * collecting files, and every resolved path lands OUTSIDE the app dir
 * (`packages/core/...` vs `packages/desktop/...`). app-builder-lib then aborts with
 * `<file> must be under <appDir>` (util/filter.ts getRelativePath). The throw fires
 * before any filter, so excluding paths in electron-builder.yml cannot help, and
 * the dep's own `files: ["dist"]` is ignored for linked deps.
 *
 * Fix: for the duration of the pack, replace the link with a REAL directory that
 * holds only what the desktop main process needs at runtime — core's built `dist/`
 * (it deep-imports `deepv-code-core/dist/src/...`) plus `package.json` (so
 * electron-builder still resolves core's production deps from the hoisted tree).
 * Because the real dir sits inside a `node_modules/` path, getRelativePath takes
 * its node_modules branch instead of throwing. The original link is always restored
 * afterwards (finally), leaving the workspace / `desktop:dev` untouched.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const coreDir = path.resolve(desktopDir, '..', 'core');

// Where the hoisted link can live. We handle whichever actually points at core.
const linkCandidates = [
  path.join(repoRoot, 'node_modules', 'deepv-code-core'),
  path.join(desktopDir, 'node_modules', 'deepv-code-core'),
];

const targets = process.argv.slice(2);
if (targets.length === 0) targets.push('--dir');

/** True if `p` links (symlink OR Windows junction) to packages/core. */
function linksToCore(p) {
  try {
    return path.resolve(fs.realpathSync(p)) === path.resolve(coreDir);
  } catch {
    return false;
  }
}

function materialize(p) {
  const distSrc = path.join(coreDir, 'dist');
  if (!fs.existsSync(distSrc)) {
    throw new Error(`core dist not found at ${distSrc} — build core first.`);
  }
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
  fs.cpSync(distSrc, path.join(p, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(coreDir, 'package.json'), path.join(p, 'package.json'));
}

function restoreLink(p) {
  fs.rmSync(p, { recursive: true, force: true });
  // junction works on Windows without admin/developer mode; dir symlink elsewhere.
  fs.symlinkSync(coreDir, p, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Local-time build stamp `YYYYMMDDHHMM`, consumed by artifactName's ${env.BUILD_TIME}.
 * Reuses a caller-provided BUILD_TIME (e.g. CI computes it up front so it can
 * predict the artifact filename before packaging even starts) instead of
 * always minting a fresh one.
 */
function buildStamp() {
  if (process.env.BUILD_TIME) return process.env.BUILD_TIME;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

function runElectronBuilder() {
  const ebPkgJson = require.resolve('electron-builder/package.json');
  const ebPkg = require(ebPkgJson);
  const binRel =
    typeof ebPkg.bin === 'string' ? ebPkg.bin : ebPkg.bin['electron-builder'];
  const ebBin = path.join(path.dirname(ebPkgJson), binRel);
  const stamp = buildStamp();
  console.log(`[pack-installer] BUILD_TIME=${stamp}`);
  // Publishing is fully disabled via `publish: []` in electron-builder.yml
  // (building from a git tag otherwise triggers an implicit publish attempt
  // that fails on our repository-less package.json — see the comment there
  // for why the CLI flag / "never" string aren't used instead).
  execFileSync(process.execPath, [ebBin, ...targets], {
    cwd: desktopDir,
    stdio: 'inherit',
    env: { ...process.env, BUILD_TIME: stamp },
  });
}

const linked = linkCandidates.filter(linksToCore);
console.log(
  `[pack-installer] targets=${targets.join(' ')} | core links to materialize: ${
    linked.length ? linked.join(', ') : '(none — core is already a real dir)'
  }`,
);

try {
  for (const p of linked) materialize(p);
  runElectronBuilder();
} finally {
  for (const p of linked) {
    restoreLink(p);
    console.log(`[pack-installer] restored workspace link: ${p}`);
  }
}
