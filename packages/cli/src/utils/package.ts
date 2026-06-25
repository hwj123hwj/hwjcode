/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import {
  readPackageUp,
  type PackageJson as BasePackageJson,
} from 'read-package-up';
import { fileURLToPath } from 'url';
import path from 'path';

export type PackageJson = BasePackageJson & {
  config?: {
    sandboxImageUri?: string;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let packageJson: PackageJson | undefined;

export async function getPackageJson(): Promise<PackageJson | undefined> {
  if (packageJson) {
    return packageJson;
  }

  const result = await readPackageUp({ cwd: __dirname });
  if (!result) {
    // 打包后 readPackageUp 可能找不到 package.json，fallback 到构建时注入的环境变量
    const injectedName = process.env.CLI_NAME;
    const injectedVersion = process.env.CLI_VERSION;
    if (injectedName && injectedVersion) {
      packageJson = { name: injectedName, version: injectedVersion } as PackageJson;
      return packageJson;
    }
    return;
  }

  packageJson = result.packageJson;
  return packageJson;
}
