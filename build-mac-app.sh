#!/bin/bash
#
# 构建 macOS 版 Gravitas 应用（当前架构 DMG）
#
# 注意：本脚本产出的 .app 是**调试包**，全部付费能力已放开（构建期注入）。
# 原因：macOS 上双击启动的 .app 由 launchd 拉起，不继承终端环境变量，
# 所以只能把放开标记在构建时就烧进产物。正式发布不要用这个脚本。
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

echo "🧹 清理打包残留（避免 electron-builder ENOTEMPTY）..."
# electron-builder 会先 rmdir out/mac-arm64 等 appOutDir；Finder 生成的 .DS_Store
# 或上次中断的临时目录会让它报 ENOTEMPTY。打包前统一清理，但保留历史 DMG/zip 产物。
find out -name ".DS_Store" -delete 2>/dev/null || true
rm -rf out/mac-arm64 out/mac-arm64.tmp out/mac-arm64-unpacked

# 所有分支统一走 scripts/dist.ts，并带 --dev-unlock。
# --dev-unlock 让 esbuild 用 --define 把放开标记烧进 main.cjs（参考 main/lib/dev-unlock.ts），
# 产出的 .app 打开即为全部付费能力放开。
# 不用 dist:fast / dist:mac 的原因：它们不注入放开标记，只能用于正式构建。
if [[ "$1" == "--signed" ]]; then
  echo "🔏 启用代码签名（自动发现证书）"
  bun run rebuild:natives && bun run scripts/dist.ts --current-arch --dmg --dev-unlock
elif [[ "$1" == "--mac" ]]; then
  echo "📦 完整 multi-arch 构建（arm64 + x64）"
  bun run rebuild:natives && bun run scripts/dist.ts --dev-unlock
else
  echo "🔓 跳过代码签名（本地测试用）"
  bun run rebuild:natives && bun run scripts/dist.ts --current-arch --dmg --no-sign --dev-unlock
fi

echo "⚠️  本次产出为调试包：全部付费能力已放开，请勿分发"

echo "✅ 构建完成，输出目录："
echo "   apps/electron/out/"
