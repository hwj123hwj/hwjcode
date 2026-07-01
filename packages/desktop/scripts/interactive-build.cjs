/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Easy Code Mac Interactive Signing & Notarization Packager
 *
 * This script runs 100% locally in your Mac's memory. It resolves your Apple ID
 * credentials automatically from environment variables / macOS Keychain (entry:
 * EC_APPLE_NOTARY), falling back to a secure masked interactive prompt when not
 * available. Credentials are never stored or logged anywhere by this script.
 */

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const Writable = require('node:stream').Writable;

// Writable stream to mask password input in terminal
const mutableStdout = new Writable({
  write: function(chunk, encoding, callback) {
    if (!this.muted) {
      process.stdout.write(chunk, encoding);
    }
    callback();
  }
});

const rl = readline.createInterface({
  input: process.stdin,
  output: mutableStdout,
  terminal: true
});

console.log("\n🚀 Easy Code macOS 交互式签名公证打包工具 🚀\n");

function askQuestion(query, isPassword = false) {
  return new Promise((resolve) => {
    mutableStdout.muted = false;
    process.stdout.write(query);
    if (isPassword) {
      mutableStdout.muted = true;
    }
    rl.question('', (answer) => {
      if (isPassword) {
        mutableStdout.muted = false;
        console.log(''); // New line after masked input
      }
      resolve(answer.trim());
    });
  });
}

// 尝试从 macOS Keychain 读取 App 专用密码（条目: EC_APPLE_NOTARY）
function readPasswordFromKeychain(appleId) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('security', [
      'find-generic-password', '-a', appleId, '-s', 'EC_APPLE_NOTARY', '-w'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim();
  } catch {
    return '';
  }
}

// 当环境变量没有 APPLE_ID 时，从 Keychain 中自动发现 Apple ID
// 查找 service=EC_APPLE_NOTARY 的条目，提取其账户名
function findAppleIdFromKeychain() {
  try {
    const { execFileSync } = require('node:child_process');
    // security find-generic-password -s EC_APPLE_NOTARY -g 会把 acct 打印到 stderr
    const out = execFileSync('security', [
      'find-generic-password', '-s', 'EC_APPLE_NOTARY', '-g'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // stderr contains "acct"<blob>="xxx@xxx.com"
    const match = out.match(/"acct"<blob>="([^"]+)"/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

// 递归扫描 release 目录，返回实际生成的 .dmg 文件路径（相对项目根，按修改时间新→旧）。
// 不再写死版本号/文件名，以实际产物为准。
function findDmgFiles(releaseDir) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.dmg')) found.push(full);
    }
  };
  walk(releaseDir);
  const cwd = process.cwd();
  return found
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .map((f) => path.relative(cwd, f));
}

async function main() {
  try {
    // 自动优先：先从环境变量读取（.zshrc 已配置从 Keychain 注入），其次直接查 Keychain
    let appleId = (process.env.APPLE_ID || '').trim();
    let applePassword = (process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD || '').trim();
    const appleTeamId = (process.env.APPLE_TEAM_ID || '6LUTP4CUH2').trim();

    // 在 env 缺失时，主动从 Keychain 发现凭证（兼容 Electron 启动无 shell profile 的场景）
    if (!appleId) {
      const keychainAppleId = findAppleIdFromKeychain();
      if (keychainAppleId) {
        appleId = keychainAppleId;
      }
    }
    if (appleId && !applePassword) {
      applePassword = readPasswordFromKeychain(appleId);
    }

    if (appleId && applePassword) {
      console.log(`\n🔑 已从环境变量 / Keychain 自动获取凭证（Apple ID: ${appleId}），跳过手动输入。`);
      rl.close();
    } else {
      // 回退：自动获取失败时，仍支持手动交互输入
      console.log("\n⚠️  未能自动获取凭证，进入手动输入模式。");
      if (!appleId) {
        appleId = await askQuestion("👉 请输入您的 Apple ID (开发者账号邮箱): ");
        if (!appleId) {
          console.log("❌ 错误：邮箱不能为空");
          rl.close();
          return;
        }
      }
      applePassword = await askQuestion("👉 请输入您的 Apple App 专用密码 (例如 xxxx-xxxx-xxxx-xxxx): ", true);
      if (!applePassword) {
        console.log("❌ 错误：密码不能为空");
        rl.close();
        return;
      }
      rl.close();
    }

    console.log("🏗️  正在为您拉起官方 macOS 代码签名、Notarytool 公证与 DMG 封装流程...\n");

    const env = {
      ...process.env,
      APPLE_ID: appleId,
      // electron-builder notarytool 自动公证读取 APPLE_APP_SPECIFIC_PASSWORD（非 APPLE_ID_PASSWORD）
      APPLE_APP_SPECIFIC_PASSWORD: applePassword,
      APPLE_TEAM_ID: appleTeamId
    };

    // Trigger electron-builder under packages/desktop with loaded variables
    const child = spawn('npm', ['run', 'pack:desktop:mac'], {
      stdio: 'inherit',
      env: env,
      shell: true
    });

    child.on('close', (code) => {
      console.log("-------------------------------------------------------------");
      if (code === 0) {
        console.log("\n🎉 【恭喜】带正规代码签名与苹果官方公证的 DMG 包已全部打包成功！");
        const dmgs = findDmgFiles(path.resolve(__dirname, '..', 'release'));
        if (dmgs.length > 0) {
          console.log("📍 DMG 分发路径:");
          for (const f of dmgs) console.log(`   ${f}`);
          console.log("");
        } else {
          console.log("📍 产物目录: packages/desktop/release/<version>/（未自动定位到 .dmg，请手动查看）\n");
        }
      } else {
        console.log(`\n❌ 打包或公证失败，退出码: ${code}`);
        console.log("💡 请检查：\n1. 您的 App 专用密码是否正确（并非苹果主密码）\n2. 苹果开发者账号是否过期或被限制\n");
      }
    });

  } catch (err) {
    console.error("Interactive script error:", err);
    rl.close();
  }
}

main();
