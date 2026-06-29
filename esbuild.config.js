/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import dotenv from 'dotenv';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require(path.resolve(__dirname, 'package.json'));

// 根据环境变量或命令行参数确定环境
const buildEnv = process.env.BUILD_ENV || process.env.NODE_ENV || 'development';

// 根据环境选择配置文件
let envFiles;
if (buildEnv === 'production') {
  envFiles = [
    'packages/cli/.env.production',
    'packages/cli/.env'
  ];
} else {
  envFiles = [
    'packages/cli/.env.development',
    'packages/cli/.env.test',
    'packages/cli/.env'
  ];
}

console.log(`🔧 Build environment: ${buildEnv}`);

// 尝试加载第一个存在的环境变量文件
for (const envFile of envFiles) {
  const envPath = path.resolve(__dirname, envFile);
  if (fs.existsSync(envPath)) {

    dotenv.config({ path: envPath });
    break;
  }
}



esbuild
  .build({
    entryPoints: ['packages/cli/index.ts'],
    bundle: true,
    outfile: 'bundle/easycode.js',
    platform: 'node',
    format: 'esm',
    minify: buildEnv === 'production', // 生产环境启用混淆
    keepNames: false, // 生产环境不保留函数名
    target: 'esnext',
    external: ['@vscode/ripgrep', 'sharp', 'yoga-layout'],
    alias: {
      'is-in-ci': path.resolve(
        __dirname,
        'packages/cli/src/patches/is-in-ci.ts',
      ),
    },
    define: {
      'process.env.CLI_VERSION': JSON.stringify(pkg.version),
      'process.env.CLI_NAME': JSON.stringify(require(path.resolve(__dirname, 'packages/cli/package.json')).name),
      'process.env.DEEPX_SERVER_URL': JSON.stringify(process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai'),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      'process.env.DEV': JSON.stringify(process.env.DEV || 'false'),
    },
    banner: {
      // The ACP stdout guard MUST be the very first code in the bundle. stdout is
      // the JSON-RPC wire in `--acp` mode and ANY stray text corrupts the frames.
      // We cannot rely on `acpStdoutGuard.ts` (imported first in the entry point)
      // here: esbuild emits deeply-shared deps like core's `proxyAuthManager`
      // singleton near the top of the bundle and the entry-only guard module near
      // the bottom, so the singleton's import-time `console.log` runs long before
      // the guard's redirect. Putting the redirect in the banner — prepended
      // literally ahead of every module — closes that window. (The source/dev path
      // still uses acpStdoutGuard.ts, where ESM import order holds.)
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url); globalThis.__filename = require('url').fileURLToPath(import.meta.url); globalThis.__dirname = require('path').dirname(globalThis.__filename);
(() => { try { const a = process.argv; if (a.some((x) => x === '--acp' || x === '--experimental-acp' || x.startsWith('--acp=') || x.startsWith('--experimental-acp='))) { const w = (...m) => { try { process.stderr.write(m.map((v) => typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })()).join(' ') + '\\n'); } catch {} }; console.log = w; console.info = w; console.warn = w; console.debug = w; } } catch {} })();`,
    },
  })
  .catch(() => process.exit(1));
