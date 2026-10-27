#!/bin/bash
# 兼容旧入口；两个渠道的构建逻辑统一由项目根目录脚本维护。
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/../build-mac-app.sh" "$@"
