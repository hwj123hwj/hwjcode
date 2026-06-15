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

async function main() {
  try {
    // 自动优先：先从环境变量读取（.zshrc 已配置从 Keychain 注入），其次直接查 Keychain
    let appleId = (process.env.APPLE_ID || '').trim();
    let applePassword = (process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD || '').trim();
    const appleTeamId = (process.env.APPLE_TEAM_ID || '6LUTP4CUH2').trim();

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
        console.log("📍 DMG 分发路径: packages/desktop/release/1.1.14/Easy Code-1.1.14-arm64.dmg\n");
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
