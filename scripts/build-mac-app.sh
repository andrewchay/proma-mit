#!/bin/bash
#
# 构建 macOS 版 Proma MIT 应用（当前架构 DMG）
#
# 用法：
#   ./scripts/build-mac-app.sh           # 从 scripts/ 子目录运行
#   ./build-mac-app.sh                   # 从项目根目录运行
#   ./build-mac-app.sh --signed          # 启用自动签名发现（需配置 Apple ID 证书）
#   ./build-mac-app.sh --mac             # 完整 multi-arch 构建（当前 CI 环境下可能失败）

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

if [[ "$1" == "--signed" ]]; then
  echo "🔏 启用代码签名（自动发现证书）"
  bun run dist:fast
elif [[ "$1" == "--mac" ]]; then
  echo "📦 完整 multi-arch 构建（arm64 + x64）"
  bun run dist:mac
else
  echo "🔓 跳过代码签名（本地测试用）"
  CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist:fast
fi

echo "✅ 构建完成，输出目录："
echo "   apps/electron/out/"
