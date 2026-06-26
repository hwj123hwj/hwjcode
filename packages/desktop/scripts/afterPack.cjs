/**
 * electron-builder afterPack hook.
 *
 * electron-builder v26+ hard-codes exclusion of any directory named
 * `node_modules` at the root of an extraResources `from` path (see
 * app-builder-lib/out/util/filter.js line 43: `if (relative === "node_modules")
 * return false`). This fires before any user-supplied filter patterns, so it
 * cannot be overridden via electron-builder.yml.
 *
 * The agent backend (`bundle/easycode.js`) is shipped as an extraResource and
 * depends at runtime on `@vscode/ripgrep` which esbuild marks as `external`.
 * That package lives in `bundle/node_modules/@vscode/ripgrep/` and must be
 * present next to `easycode.js` inside the packaged app.
 *
 * Fix: after electron-builder finishes copying extraResources (without
 * node_modules), this hook manually copies `bundle/node_modules` into the
 * `backend/` directory inside the app.
 */

const fs = require('node:fs');
const path = require('node:path');

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

exports.default = async function afterPack(context) {
  const { appOutDir } = context;
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const bundleNodeModules = path.join(repoRoot, 'bundle', 'node_modules');

  if (!fs.existsSync(bundleNodeModules)) {
    console.warn('[afterPack] bundle/node_modules not found, skipping injection');
    return;
  }

  // macOS: <appOutDir>/Easy Code.app/Contents/Resources/backend/
  // Windows/Linux: <appOutDir>/resources/backend/
  let backendDir;
  const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'

  if (platform === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    backendDir = path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources', 'backend');
  } else {
    backendDir = path.join(appOutDir, 'resources', 'backend');
  }

  if (!fs.existsSync(backendDir)) {
    console.warn(`[afterPack] backend dir not found at ${backendDir}, skipping`);
    return;
  }

  const destNodeModules = path.join(backendDir, 'node_modules');
  console.log(`[afterPack] injecting bundle/node_modules → ${destNodeModules}`);
  copyDirSync(bundleNodeModules, destNodeModules);
  console.log('[afterPack] node_modules injection complete');
};
