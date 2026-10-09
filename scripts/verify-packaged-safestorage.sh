#!/usr/bin/env bash
# 打包版 safeStorage 验证（只读，不输出任何密钥内容）。
#
# 用法：
#   bash scripts/verify-packaged-safestorage.sh [path/to/Gravitas.app]
# 未指定路径时在 apps/electron/out/mac*/ 下查找 Gravitas.app。
#
# 建议先构建开发版验收包（与正式版同 bundle id，注意本机只保留一个 Gravitas 版本）：
#   cd apps/electron && bun run dist:mac-dev-zip
#
# 脚本只做四件事：签名校验、钥匙串条目检查、渠道密钥密文格式计数、打印手动验证步骤。
# 它不会修改 ~/.gravitas，也不会读取或输出任何 API Key 内容。
set -euo pipefail

APP="${1:-}"
if [[ -z "$APP" ]]; then
  APP="$(ls -d apps/electron/out/mac*/Gravitas.app 2>/dev/null | head -1 || true)"
fi
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "未找到 Gravitas.app。请先构建，或把 .app 路径作为参数传入。" >&2
  exit 2
fi
echo "== 应用包：$APP"

echo
echo "== 1. 签名身份（codesign）"
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "签名校验：通过"
else
  echo "签名校验：失败（未签名或签名被破坏；safeStorage 的钥匙串 ACL 依赖签名身份，结果需谨慎解读）"
fi
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Signature)=' || true

echo
echo "== 2. 钥匙串条目（仅检查是否存在，不读取密码）"
if security find-generic-password -s "Gravitas Safe Storage" >/dev/null 2>&1; then
  echo "存在：Gravitas Safe Storage"
else
  echo "不存在：首次使用 safeStorage 时由应用创建；若应用从未加密过数据，这是正常的"
fi

echo
echo "== 3. 渠道密钥格式（只计数，不输出内容）"
python3 - <<'PY'
import json, os, sys
path = os.path.expanduser('~/.gravitas/channels.json')
if not os.path.exists(path):
    print('未找到 ~/.gravitas/channels.json，跳过（尚未配置渠道）')
    sys.exit(0)
raw = json.load(open(path))
channels = raw if isinstance(raw, list) else raw.get('channels', [])
encrypted = plain = empty = 0
for channel in channels:
    key = str(channel.get('apiKey', ''))
    if not key:
        empty += 1
    elif key.startswith('djEw'):  # base64('v10')：macOS safeStorage 密文前缀
        encrypted += 1
    else:
        plain += 1
print(f'渠道总数={len(channels)} 密文(v10)={encrypted} 明文或其他格式={plain} 空={empty}')
if plain:
    print('警告：存在非 v10 密文的密钥。请确认是否在 safeStorage 不可用时保存，并在应用内重新保存该渠道。')
PY

echo
echo "== 4. 手动验证（需要你在本机操作）"
cat <<'MSG'
a) 打开打包版 Gravitas.app（不要用开发版 electron 启动）。
b) 设置 → 渠道 → 选择一个已配置的渠道 → 点击“测试连接”。
c) 若连接测试成功，说明打包版可以解密 safeStorage 中的 API Key。
d) 若失败，记录界面提示文字（不要粘贴 API Key），并记下 macOS 是否弹出钥匙串访问确认框。
e) 请把本脚本的输出与 b)–d) 的结果告诉我。
MSG
