#!/bin/bash
#
# 一次构建 macOS 版 Gravitas Dev 与 Stable 应用（默认当前架构 DMG）
#
# Dev 包会注入调试解锁标记，仅供本地验收，不能分发。
# Stable 包使用生产身份与正式功能门禁；本脚本只本地构建，不上传发布。
#
# 用法：
#   ./scripts/build-mac-app.sh           # 从 scripts/ 子目录运行
#   ./build-mac-app.sh                   # 从项目根目录运行
#   ./build-mac-app.sh --signed          # 两个应用都启用自动签名发现（需配置 Apple Developer 证书）
#   ./build-mac-app.sh --mac             # 两个应用都构建 arm64 + x64

set -e

# 智能定位项目根目录
# 1. 如果当前目录就是项目根目录（包含 apps/electron/package.json），直接用当前目录
# 2. 如果脚本在 scripts/ 子目录下，则切换到父目录
if [ -f "apps/electron/package.json" ]; then
  PROJECT_ROOT="$(pwd)"
elif [ -f "$(dirname "$0")/../apps/electron/package.json" ]; then
  PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
else
  echo "❌ 找不到项目根目录（需要包含 apps/electron/package.json）"
  echo "   请在 proma-mit 项目根目录或 scripts/ 目录下运行此脚本"
  exit 1
fi

cd "$PROJECT_ROOT"

echo "🛠  开始构建 macOS 应用..."
echo "   项目根目录: $PROJECT_ROOT"

cd apps/electron

SIGNED=false
MULTI_ARCH=false
for arg in "$@"; do
  case "$arg" in
    --signed) SIGNED=true ;;
    --mac) MULTI_ARCH=true ;;
    *)
      echo "❌ 未知参数: $arg"
      echo "   支持参数：--signed、--mac"
      exit 2
      ;;
  esac
done

BUILD_ARGS=(--dmg)
if [[ "$MULTI_ARCH" == "true" ]]; then
  echo "📦 构建 arm64 + x64（Dev 与 Stable）"
else
  BUILD_ARGS+=(--current-arch)
  echo "📦 构建当前架构（Dev 与 Stable）"
fi

if [[ "$SIGNED" == "true" ]]; then
  echo "🔏 启用代码签名（自动发现证书）"
else
  BUILD_ARGS+=(--no-sign)
  echo "🔓 跳过代码签名（本地测试用）"
fi

echo "🔎 校验 Stable 发布渠道配置..."
bun run scripts/check-release-channel.ts

echo "🔧 重建原生依赖..."
bun run rebuild:natives

echo "🧪 构建 Gravitas Dev（独立身份，调试解锁，仅供本地验收）..."
bun run scripts/dist.ts --dev --dev-unlock "${BUILD_ARGS[@]}"

echo "🚀 构建 Gravitas Stable（正式身份与功能门禁）..."
bun run scripts/dist.ts "${BUILD_ARGS[@]}"

echo "✅ 两个应用均构建完成："
echo "   Dev:    apps/electron/out-dev/"
echo "   Stable: apps/electron/out/"
