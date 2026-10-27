#!/bin/bash
#
# 构建 macOS 版 Gravitas Dev 与 Stable（当前架构 DMG）
#
# Dev 包会在构建期放开全部付费能力，仅供本地调试，请勿分发。
# Stable 包使用正式功能门控，不注入调试放开标记。
#
# 用法：
#   ./build-mac-app.sh                   # 两个渠道，当前架构 DMG，不签名
#   ./build-mac-app.sh --signed          # 两个渠道，当前架构 DMG，启用自动签名发现
#   ./build-mac-app.sh --mac             # 两个渠道，完整 multi-arch 构建

set -e

# 两个入口统一转到本脚本所在仓库，不依赖调用时的工作目录。
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$PROJECT_ROOT/apps/electron/package.json" ]; then
  echo "❌ 找不到项目根目录（需要包含 apps/electron/package.json）"
  exit 1
fi

cd "$PROJECT_ROOT"

echo "🛠  开始构建 macOS 应用..."
echo "   项目根目录: $PROJECT_ROOT"

cd apps/electron

case "${1:-}" in
  --mac)
    echo "📦 构建完整 multi-arch（arm64 + x64）"
    BUILD_ARGS=()
    ;;
  --signed)
    echo "🔏 启用代码签名（自动发现证书）"
    BUILD_ARGS=(--current-arch --dmg)
    ;;
  *)
    echo "🔓 跳过代码签名（本地测试用）"
    BUILD_ARGS=(--current-arch --dmg --no-sign)
    ;;
esac

echo "🔧 重建原生依赖..."
bun run rebuild:natives

echo "🧪 构建 Gravitas Dev（调试放开，仅供本地使用）..."
bun run scripts/dist.ts "${BUILD_ARGS[@]}" --dev --dev-unlock

echo "📦 构建 Gravitas Stable（正式功能门控）..."
bun run scripts/dist.ts "${BUILD_ARGS[@]}"

echo "✅ 两个渠道构建完成："
echo "   Dev:    apps/electron/out-dev/"
echo "   Stable: apps/electron/out/"
