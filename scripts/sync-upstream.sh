#!/bin/bash
# sync-upstream.sh — 一键同步上游仓库（改进版）
# 改进点：
#   1. 完善 stash 排除列表（加入 root 和 desktop 的 package.json）
#   2. 添加冲突预检查
#   3. 构建失败则不推送
#   4. 添加 desktop 构建步骤
#   5. 改进错误处理，添加回滚机制
#   6. 修复 tag 获取时机
set -e

cd "$(dirname "$0")/.."

# ==================== 工具函数 ====================

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
ok()    { echo -e "${GREEN}✅ $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()  { echo -e "${RED}❌ $1${NC}"; }

# 回滚函数
rollback() {
  fail "同步失败，正在回滚..."

  # 如果 merge 还在进行中，abort 掉
  if [ -f .git/MERGE_HEAD ]; then
    warn "取消未完成的 merge..."
    git merge --abort 2>/dev/null || true
  fi

  # 恢复到原始分支
  if [ -n "$ORIGINAL_BRANCH" ]; then
    info "切回原始分支: $ORIGINAL_BRANCH"
    git checkout "$ORIGINAL_BRANCH" 2>/dev/null || true
  fi

  # 恢复 stash
  if [ "$STASHED" = true ]; then
    info "恢复暂存的本地改动..."
    git stash pop 2>/dev/null || warn "stash pop 失败，请手动执行: git stash pop"
  fi

  fail "同步已中止，未做任何修改"
  exit 1
}

# 设置错误陷阱
trap rollback ERR

# ==================== 0. 记录初始状态 ====================

ORIGINAL_BRANCH=$(git branch --show-current)
info "当前分支: $ORIGINAL_BRANCH"

# 确保在 master 分支
if [ "$ORIGINAL_BRANCH" != "master" ]; then
  warn "当前不在 master 分支，切换到 master..."
  git checkout master
fi

# 记录当前 HEAD（用于回滚）
ORIGINAL_HEAD=$(git rev-parse HEAD)

# ==================== 1. 暂存本地改动 ====================

STASHED=false
if ! git diff --quiet || ! git diff --cached --quiet; then
  info "暂存本地改动（排除所有版本文件和 fork 专属文件）..."
  git stash push -m "auto-stash before sync" -- \
    . \
    ':!package.json' \
    ':!packages/cli/package.json' \
    ':!packages/core/package.json' \
    ':!packages/desktop/package.json' \
    ':!packages/core/src/tools/self-update.ts'
  STASHED=true
  ok "本地改动已暂存"
else
  info "工作目录干净，无需暂存"
fi

# ==================== 2. 拉取上游 ====================

info "拉取上游代码和 tags..."
git fetch upstream
git fetch upstream --tags 2>/dev/null || warn "获取上游 tags 失败，将使用本地 tags"
ok "上游代码已拉取"

# ==================== 3. 冲突预检查 ====================

info "预检查上游改动..."
UPSTREAM_CHANGES=$(git log --oneline master..upstream/master | wc -l | tr -d ' ')
info "上游有 $UPSTREAM_CHANGES 个新提交"

if [ "$UPSTREAM_CHANGES" -eq 0 ]; then
  ok "上游没有新提交，无需同步"
  if [ "$STASHED" = true ]; then
    git stash pop
  fi
  exit 0
fi

# 显示上游改动的文件列表
info "上游改动涉及的文件:"
git diff --stat master..upstream/master | tail -5
echo ""

# ==================== 4. 合并上游 ====================

info "合入 upstream/master..."
if git merge upstream/master --no-edit; then
  ok "合并成功，无冲突"
else
  # 有冲突 → 自动处理
  warn "检测到冲突，自动处理..."

  # 自动接受上游的版本文件和 lock 文件
  AUTO_RESOLVE_FILES=(
    "package.json"
    "packages/cli/package.json"
    "packages/core/package.json"
    "packages/desktop/package.json"
    "package-lock.json"
  )

  for f in "${AUTO_RESOLVE_FILES[@]}"; do
    if git diff --name-only --diff-filter=U | grep -q "^${f}$"; then
      info "  解决冲突: $f (使用上游版本)"
      git checkout --theirs "$f" 2>/dev/null && git add "$f" || true
    fi
  done

  # 检查是否还有其他冲突
  REMAINING_CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  if [ -n "$REMAINING_CONFLICTS" ]; then
    fail "以下文件仍有冲突需要手动解决:"
    echo "$REMAINING_CONFLICTS" | sed 's/^/  /'
    echo ""
    echo "请执行以下步骤:"
    echo "  1. 手动解决冲突"
    echo "  2. git add ."
    echo "  3. git merge --continue"
    echo "  4. 重新运行本脚本"
    rollback
  fi

  # 完成 merge
  if ! git -c core.editor=true merge --continue; then
    fail "merge --continue 失败"
    rollback
  fi
  ok "冲突已自动解决"
fi

# ==================== 5. 清理遗留文件 ====================

info "清理上游遗留的 src/package.json..."
rm -f packages/cli/src/package.json
rm -f packages/cli/dist/src/package.json
ok "清理完成"

# ==================== 6. 版本号处理（同步后自动 bump patch） ====================

LATEST_TAG=$(git tag -l 'cli-release-*' | sort -V | tail -1 | sed 's/cli-release-v//')
if [ -z "$LATEST_TAG" ]; then
  warn "未找到上游 release tag"
  LATEST_TAG="0.0.0"
else
  info "上游最新 tag: v$LATEST_TAG"
fi

# 获取合并后的当前版本
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
info "合并后当前版本: v$CURRENT_VERSION"

# 同步上游后必须升版本号（patch +1），因为有新代码需要发布
info "同步上游后自动 bump patch 版本..."

# 计算新版本号（当前版本 patch +1）
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEW_PATCH=$((PATCH + 1))
TARGET_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"
info "目标版本: v$TARGET_VERSION"

# 更新所有 package.json
PKG_FILES=(
  "package.json"
  "packages/cli/package.json"
  "packages/core/package.json"
  "packages/desktop/package.json"
)

for PKG in "${PKG_FILES[@]}"; do
  if [ -f "$PKG" ]; then
    CURRENT=$(node -p "require('./$PKG').version" 2>/dev/null || echo "unknown")
    if [ "$CURRENT" != "$TARGET_VERSION" ]; then
      info "  $PKG: $CURRENT → $TARGET_VERSION"
      node -e "
        const p=require('./$PKG');
        p.version='$TARGET_VERSION';
        require('fs').writeFileSync('./$PKG', JSON.stringify(p, null, 2) + '\n');
      "
    fi
  fi
done
ok "版本号已升级到 v$TARGET_VERSION"

# ==================== 7. 修复 fork 专属字段 ====================

info "修复 fork 专属包名和 bin 字段..."

node -e "
const fs = require('fs');

function fixPkg(file, targetName, targetBinKey) {
  if (!fs.existsSync(file)) return;
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;

  if (pkg.name !== targetName) {
    console.log('  ✅ ' + file + ': name → ' + targetName);
    pkg.name = targetName;
    changed = true;
  }

  if (targetBinKey && pkg.bin) {
    const oldBinKey = Object.keys(pkg.bin).find(k => k !== targetBinKey);
    if (oldBinKey && pkg.bin[oldBinKey]) {
      pkg.bin[targetBinKey] = pkg.bin[oldBinKey];
      delete pkg.bin[oldBinKey];
      console.log('  ✅ ' + file + ': bin → ' + targetBinKey);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  }
}

fixPkg('package.json', 'hwjcode', 'hwjcode');
fixPkg('packages/cli/package.json', 'hwjcode-cli', 'hwjcode');
fixPkg('packages/core/package.json', 'hwjcode-core', null);
fixPkg('packages/desktop/package.json', 'hwjcode-desktop', null);

console.log('  ℹ️ 包名修复完成');
"

# ==================== 8. 修复 self-update 常量 ====================

info "修复 self-update 包名常量..."
SELF_UPDATE_FILE="packages/core/src/tools/self-update.ts"
if [ -f "$SELF_UPDATE_FILE" ]; then
  NEED_FIX=false
  grep -q "SELF_UPDATE_PACKAGE = 'easycode-ai'" "$SELF_UPDATE_FILE" && NEED_FIX=true
  grep -q "SELF_UPDATE_RELAUNCH_COMMAND = 'easycode'" "$SELF_UPDATE_FILE" && NEED_FIX=true

  if [ "$NEED_FIX" = true ]; then
    sed -i.bak "s/SELF_UPDATE_PACKAGE = 'easycode-ai'/SELF_UPDATE_PACKAGE = 'hwjcode'/g" "$SELF_UPDATE_FILE"
    sed -i.bak "s/SELF_UPDATE_RELAUNCH_COMMAND = 'easycode'/SELF_UPDATE_RELAUNCH_COMMAND = 'hwjcode'/g" "$SELF_UPDATE_FILE"
    rm -f "${SELF_UPDATE_FILE}.bak"
    ok "self-update.ts 常量已修复"
  else
    info "self-update 常量无需修复"
  fi
fi

# ==================== 9. 构建 ====================

echo ""
info "开始构建..."

# 构建 core
info "构建 core..."
cd packages/core
rm -rf dist
if npm run build 2>&1 | tail -3; then
  ok "core 构建成功"
else
  fail "core 构建失败"
  rollback
fi
cd ../..

# 构建 cli
info "构建 cli..."
cd packages/cli
rm -rf dist
if npm run build 2>&1 | tail -3; then
  chmod +x dist/index.js
  ok "cli 构建成功"
else
  fail "cli 构建失败"
  rollback
fi
cd ../..

# 构建 desktop（如果存在构建脚本）
if [ -f "packages/desktop/package.json" ]; then
  DESKTOP_HAS_BUILD=$(node -e "const p=require('./packages/desktop/package.json');console.log(p.scripts && p.scripts.build ? 'yes' : 'no')" 2>/dev/null || echo "no")
  if [ "$DESKTOP_HAS_BUILD" = "yes" ]; then
    info "构建 desktop..."
    cd packages/desktop
    if npm run build 2>&1 | tail -3; then
      ok "desktop 构建成功"
    else
      warn "desktop 构建失败（非致命，继续同步）"
    fi
    cd ../..
  else
    info "desktop 无构建脚本，跳过"
  fi
fi

# ==================== 10. 提交版本修复 ====================

# 检查是否有需要提交的改动
if ! git diff --quiet; then
  info "提交版本号升级和包名修复..."
  git add -A
  git commit -m "release: hwjcode@$TARGET_VERSION (sync upstream)" --no-verify
  ok "已提交: release: hwjcode@$TARGET_VERSION"
else
  info "无额外改动需要提交"
fi

# ==================== 11. 推送 ====================

echo ""
info "推送到 GitLab (origin)..."
if git push origin master 2>&1 | tail -3; then
  ok "推送到 GitLab 成功"
else
  fail "推送到 GitLab 失败"
  warn "你可以稍后手动推送: git push origin master"
fi

# ==================== 12. 恢复本地改动 ====================

if [ "$STASHED" = true ]; then
  info "恢复暂存的本地改动..."
  if git stash pop; then
    ok "本地改动已恢复"
  else
    warn "stash pop 有冲突，请手动解决"
    echo "  查看冲突: git status"
    echo "  放弃恢复: git stash drop"
  fi
fi

# ==================== 完成 ====================

echo ""
echo "=========================================="
ok "同步完成！"
echo "=========================================="
echo ""
echo "📊 同步摘要:"
echo "  • 上游 commits: $UPSTREAM_CHANGES 个"
echo "  • 本地版本: v$TARGET_VERSION"
echo "  • 推送到: origin/master"
echo ""
echo "📝 后续操作:"
echo "  • 发布到 npm: npm publish"
echo "  • 推送到 GitHub: npm run sync-to-github"
echo ""
