#!/bin/bash
# sync-upstream.sh — 一键同步上游仓库
set -e

cd "$(dirname "$0")/.."

# 0. 暂存本地未提交的改动
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "📦 暂存本地改动（排除版本文件）..."
  git stash push -m "auto-stash before sync" -- . ':!packages/cli/package.json' ':!packages/core/package.json'
  STASHED=true
fi

echo "📥 拉取上游..."
git fetch upstream

echo "🔀 合入 master..."
git checkout master
if ! git merge upstream/master --no-edit; then
  # 有冲突 → 自动接受上游的 package.json 版本号
  echo "⚠️ 检测到冲突，自动处理版本号相关文件..."
  for f in packages/cli/package.json packages/core/package.json; do
    git checkout --theirs "$f" 2>/dev/null && git add "$f" || true
  done
  # 其他冲突（除 package.json 外）需要手动处理
  if ! git merge --continue --no-edit 2>/dev/null; then
    echo "❗ 仍有非版本号冲突，请手动解决: git diff --name-only --diff-filter=U"
    echo "   解决后执行: git add . && git merge --continue"
    exit 1
  fi
fi

# 清理上游遗留的 src/package.json（会污染版本号读取）
rm -f packages/cli/src/package.json
rm -f packages/cli/dist/src/package.json

# 获取上游最新 tag 版本号
git fetch upstream --tags 2>/dev/null || true
LATEST_TAG=$(git tag -l 'cli-release-*' | sort -V | tail -1 | sed 's/cli-release-v//')
echo "🏷️ 上游最新 tag: $LATEST_TAG"

# 确保版本号对齐 tag（同步到 root、cli、core、desktop 四个 package.json）
ROOT_PKG="package.json"
CLI_PKG="packages/cli/package.json"
CORE_PKG="packages/core/package.json"
DESKTOP_PKG="packages/desktop/package.json"

for PKG in "$ROOT_PKG" "$CLI_PKG" "$CORE_PKG" "$DESKTOP_PKG"; do
  CURRENT=$(node -p "require('./$PKG').version")
  if [ "$CURRENT" != "$LATEST_TAG" ]; then
    echo "📝 $PKG 版本: $CURRENT → $LATEST_TAG"
    node -e "
      const p=require('./$PKG');p.version='$LATEST_TAG';
      require('fs').writeFileSync('./$PKG',JSON.stringify(p,null,2)+'\n')
    "
  fi
done

# 修复上游覆盖的 fork 专属字段（包名 + bin 命令名）
# 上游 package.json 里 name/bin 仍是 easycode-*/easycode，合并后会覆盖我们的 hwjcode
echo "🔧 修复 fork 专属包名和 bin 字段..."

node -e "
const fs = require('fs');

// Root package.json: name + bin
const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let rootChanged = false;
if (root.name !== 'hwjcode') { root.name = 'hwjcode'; rootChanged = true; }
if (root.bin && root.bin.easycode) { root.bin.hwjcode = root.bin.easycode; delete root.bin.easycode; rootChanged = true; }
if (rootChanged) { fs.writeFileSync('package.json', JSON.stringify(root, null, 2) + '\n'); console.log('  ✅ package.json: name → hwjcode, bin → hwjcode'); }

// CLI package.json: name + bin
const cli = JSON.parse(fs.readFileSync('packages/cli/package.json', 'utf8'));
let cliChanged = false;
if (cli.name !== 'hwjcode-cli') { cli.name = 'hwjcode-cli'; cliChanged = true; }
if (cli.bin && cli.bin.easycode) { cli.bin.hwjcode = cli.bin.easycode; delete cli.bin.easycode; cliChanged = true; }
if (cliChanged) { fs.writeFileSync('packages/cli/package.json', JSON.stringify(cli, null, 2) + '\n'); console.log('  ✅ packages/cli/package.json: name → hwjcode-cli, bin → hwjcode'); }

// Core package.json: name
const core = JSON.parse(fs.readFileSync('packages/core/package.json', 'utf8'));
if (core.name !== 'hwjcode-core') { core.name = 'hwjcode-core'; fs.writeFileSync('packages/core/package.json', JSON.stringify(core, null, 2) + '\n'); console.log('  ✅ packages/core/package.json: name → hwjcode-core'); }

// Desktop package.json: name
const desktop = JSON.parse(fs.readFileSync('packages/desktop/package.json', 'utf8'));
if (desktop.name !== 'hwjcode-desktop') { desktop.name = 'hwjcode-desktop'; fs.writeFileSync('packages/desktop/package.json', JSON.stringify(desktop, null, 2) + '\n'); console.log('  ✅ packages/desktop/package.json: name → hwjcode-desktop'); }

if (!rootChanged && !cliChanged && core.name === 'hwjcode-core' && desktop.name === 'hwjcode-desktop') {
  console.log('  ℹ️ 包名和 bin 字段无需修复，已是 hwjcode 系列');
}
"

# 同步修复 self-update 常量（上游可能覆盖回 easycode-ai）
echo "🔧 修复 self-update 包名常量..."
SELF_UPDATE_FILE="packages/core/src/tools/self-update.ts"
if [ -f "$SELF_UPDATE_FILE" ]; then
  NEED_FIX=false
  grep -q "SELF_UPDATE_PACKAGE = 'easycode-ai'" "$SELF_UPDATE_FILE" && NEED_FIX=true
  grep -q "SELF_UPDATE_RELAUNCH_COMMAND = 'easycode'" "$SELF_UPDATE_FILE" && NEED_FIX=true
  if [ "$NEED_FIX" = true ]; then
    sed -i.bak "s/SELF_UPDATE_PACKAGE = 'easycode-ai'/SELF_UPDATE_PACKAGE = 'hwjcode'/g" "$SELF_UPDATE_FILE"
    sed -i.bak "s/SELF_UPDATE_RELAUNCH_COMMAND = 'easycode'/SELF_UPDATE_RELAUNCH_COMMAND = 'hwjcode'/g" "$SELF_UPDATE_FILE"
    rm -f "${SELF_UPDATE_FILE}.bak"
    echo "  ✅ self-update.ts: SELF_UPDATE_PACKAGE → hwjcode, SELF_UPDATE_RELAUNCH_COMMAND → hwjcode"
  else
    echo "  ℹ️ self-update 常量无需修复"
  fi
fi

echo "🔨 构建..."
cd packages/core && rm -rf dist && npm run build --silent 2>&1 | tail -1
cd ../cli && rm -rf dist && npm run build --silent 2>&1 | tail -1 && chmod +x dist/index.js

# 推送到自己的 GitLab 远程仓库
echo "🚀 推送到 GitLab..."
git push origin master 2>&1 | tail -1

# 恢复本地改动
if [ "$STASHED" = true ]; then
  echo "📤 恢复本地改动..."
  git stash pop || echo "⚠️ stash pop 失败，请手动执行 git stash pop"
fi

echo "✅ 同步完成，版本: $LATEST_TAG"
