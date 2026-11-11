#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/home/config-audit" "$tmpdir/home/runs" "$tmpdir/support/Gravitas/Cache" "$tmpdir/support/Gravitas Owner Test" "$tmpdir/apps/Gravitas.other.app" "$tmpdir/bin"
printf 'audit\n' > "$tmpdir/home/config-audit/events.jsonl"
printf 'runs\n' > "$tmpdir/home/runs/2026-10.jsonl"
touch "$tmpdir/support/Gravitas Owner Test/data" "$tmpdir/apps/Gravitas.other.app/data" "$tmpdir/support/Gravitas/Cache/data"
printf '#!/bin/sh\nexit 1\n' > "$tmpdir/bin/pgrep"
chmod +x "$tmpdir/bin/pgrep"
export GRAVITAS_HOME_OVERRIDE="$tmpdir/home" GRAVITAS_APPSUPPORT_OVERRIDE="$tmpdir/support" GRAVITAS_APPS_DIR_OVERRIDE="$tmpdir/apps" PATH="$tmpdir/bin:$PATH"
bash "$root/cleanup-gravitas.sh" >/dev/null
test -f "$tmpdir/support/Gravitas/Cache/data"
if bash "$root/cleanup-gravitas.sh" --yes --tier=venv,apps,audit,runs,residue >/dev/null; then exit 1; fi
test "$(cat "$tmpdir/home/config-audit/events.jsonl")" = audit
test -f "$tmpdir/home/runs/2026-10.jsonl"
test -f "$tmpdir/support/Gravitas Owner Test/data"
test -f "$tmpdir/apps/Gravitas.other.app/data"
bash "$root/cleanup-gravitas.sh" --yes >/dev/null
test ! -e "$tmpdir/support/Gravitas/Cache/data"
printf '清理范围行为测试通过\n'
