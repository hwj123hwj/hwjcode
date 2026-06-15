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

# 获取上游最新 tag 版本号
git fetch upstream --tags 2>/dev/null || true
LATEST_TAG=$(git tag -l 'cli-release-*' | sort -V | tail -1 | sed 's/cli-release-v//')
echo "🏷️ 上游最新 tag: $LATEST_TAG"

# 确保版本号对齐 tag
CURRENT_CLI=$(node -p "require('./packages/cli/package.json').version")
CURRENT_CORE=$(node -p "require('./packages/core/package.json').version")

if [ "$CURRENT_CLI" != "$LATEST_TAG" ]; then
  echo "📝 CLI 版本: $CURRENT_CLI → $LATEST_TAG"
  node -e "
    const p=require('./packages/cli/package.json');p.version='$LATEST_TAG';
    require('fs').writeFileSync('./packages/cli/package.json',JSON.stringify(p,null,2)+'\n')
  "
fi

if [ "$CURRENT_CORE" != "$LATEST_TAG" ]; then
  echo "📝 Core 版本: $CURRENT_CORE → $LATEST_TAG"
  node -e "
    const p=require('./packages/core/package.json');p.version='$LATEST_TAG';
    require('fs').writeFileSync('./packages/core/package.json',JSON.stringify(p,null,2)+'\n')
  "
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
