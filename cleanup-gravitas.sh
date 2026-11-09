#!/bin/bash
#
# Gravitas 空间清理脚本  (v2)
#
# 用法：
#   bash cleanup-gravitas.sh                  # 预演，只统计不删除
#   bash cleanup-gravitas.sh --yes            # 执行全部清理
#   bash cleanup-gravitas.sh --yes --tier=venv,apps    # 只清理指定项
#   bash cleanup-gravitas.sh --list           # 列出所有清理项
#
# 建议：清理缓存类（T6）前先退出 Gravitas。
#
# 预计可回收：约 18.2 GB
#
#    T1 venv      8.8 GB   ma-media-crawler 的 Python 虚拟环境，18 个工作区各一份重复副本
#    T2 apps      4.3 GB   /Applications 下 5 个旧版本 app 副本
#    T3 audit     1.97GB   config-audit/events.jsonl 归档（2.1GB -> 约 130MB，实测压缩率 6%）
#    T4 runs      0.85GB   8-10 月 run 日志归档（947MB -> 约 95MB，实测压缩率 10%）
#    T5 residue   1.4 GB   Application Support 下的历史测试残留
#    T6 cache     0.9 GB   Chromium 缓存（会自动重建）
#
# T3 / T4 是归档不是丢弃：原始内容压缩保留为 .gz，可随时解压回查。
#
set -uo pipefail

# ---------------- 配置 ----------------
# 下列路径支持环境变量覆盖，便于在沙箱中做自测。
GRAVITAS_DIR="${GRAVITAS_HOME_OVERRIDE:-$HOME/.gravitas}"
APP_SUPPORT="${GRAVITAS_APPSUPPORT_OVERRIDE:-$HOME/Library/Application Support}"
APPS_DIR="${GRAVITAS_APPS_DIR_OVERRIDE:-/Applications}"

# T2：要保留的 app（白名单，其余 Gravitas 相关副本都会被清理）
APPS_KEEP=(
  "Gravitas.app"
  "Gravitas Dev.app"
  "Gravitas.pre-owner-0.13.571.app"   # 保留为回滚点
)
# 匹配范围：Gravitas 开头的所有 app 副本；白名单内的跳过
APPS_GLOB_PATTERN="Gravitas*.app"

# T5：要删除的 Application Support 残留（Gravitas 和 Gravitas Dev 正在使用，不碰）
RESIDUE_DIRS=(
  "Gravitas Dev Backups"
  "GravitAI"
)
# Owner Test 系列用通配匹配

# ---------------- 参数解析 ----------------
DRY_RUN=1
TIERS="venv,apps,audit,runs,residue,cache"

for arg in "$@"; do
  case "$arg" in
    --yes|-y)      DRY_RUN=0 ;;
    --tier=*)      TIERS="${arg#--tier=}" ;;
    --list)
      echo "可用清理项："
      echo "  venv     8.8 GB   ma-media-crawler 重复虚拟环境（18 份）"
      echo "  apps     4.3 GB   /Applications 旧版本副本（5 个）"
      echo "  audit   1.95 GB   config-audit 审计日志轮转"
      echo "  runs     0.95 GB  8-10 月 run 日志压缩"
      echo "  residue  1.4 GB   Application Support 历史残留"
      echo "  cache    0.9 GB   Chromium 缓存"
      exit 0 ;;
    --doctor)
      echo "=== 环境诊断 ==="
      echo "当前用户:      $(whoami)"
      echo "HOME:          $HOME"
      echo "脚本路径:      $0"
      echo "bash 版本:     $BASH_VERSION"
      echo "sudo 权限:     $(sudo -n true 2>/dev/null && echo '已缓存(无需密码)' || echo '需要密码')"
      echo
      echo "=== 目标路径可写性 ==="
      for d in "$GRAVITAS_DIR" "$APP_SUPPORT" "$APPS_DIR" "$GRAVITAS_DIR/config-audit" "$GRAVITAS_DIR/runs"; do
        if [ ! -e "$d" ]; then printf '  %-52s 不存在\n' "$d"; continue; fi
        if touch "$d/.wtest_$" 2>/dev/null; then rm -f "$d/.wtest_$"; printf '  %-52s 可写 ✓\n' "$d"
        else printf '  %-52s 不可写 ✗\n' "$d"; fi
      done
      echo
      echo "=== 待清理项是否存在 ==="
      printf '  .venv 份数:                 %s\n' "$(find "$GRAVITAS_DIR/agent-workspaces" -type d -name .venv -path '*/ma-media-crawler/*' 2>/dev/null | wc -l | tr -d ' ')"
      printf '  Gravitas*.app 个数:         %s\n' "$(ls -d "$APPS_DIR"/Gravitas*.app 2>/dev/null | wc -l | tr -d ' ')"
      printf '  config-audit/events.jsonl:  %s\n' "$(du -sh "$GRAVITAS_DIR/config-audit/events.jsonl" 2>/dev/null | cut -f1)"
      printf '  runs/*.jsonl:               %s\n' "$(ls "$GRAVITAS_DIR"/runs/*.jsonl 2>/dev/null | wc -l | tr -d ' ')"
      echo
      echo "=== Gravitas 是否运行 ==="
      if pgrep -f "Gravitas.app/Contents/MacOS/Gravitas" >/dev/null 2>&1; then
        echo "  正在运行（T6 缓存清理会被跳过）"
      else
        echo "  未运行"
      fi
      exit 0 ;;
    -h|--help)
      sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "未知参数: $arg（用 --help 查看用法）" >&2
      exit 2 ;;
  esac
done

has_tier() { case ",$TIERS," in *",$1,"*) return 0 ;; esac; return 1; }

# ---------------- 工具函数 ----------------
# ---------------- 日志（方便事后核对到底做了什么） ----------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/cleanup-gravitas.log"
: > "$LOG_FILE" 2>/dev/null || true
logline() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG_FILE" 2>/dev/null || true; }

# ---------------- 启动预检：先确认目标路径真的可写 ----------------
# 这一段是必须的。若在受限终端（如应用内嵌终端、沙箱 shell）里运行，
# 所有删除都会返回 EPERM，旧版本脚本会因为 `rm && printf` 静默失败，
# 表现为"跑了但什么都没发生"。这里提前拦下并给出明确指引。
can_write() {
  local d="$1"
  [ -e "$d" ] || return 1
  if touch "$d/.wpreflight_$" 2>/dev/null; then
    rm -f "$d/.wpreflight_$" 2>/dev/null
    return 0
  fi
  return 1
}

preflight() {
  local need_write=()
  has_tier venv     && need_write+=("$GRAVITAS_DIR")
  has_tier audit    && need_write+=("$GRAVITAS_DIR/config-audit")
  has_tier runs     && need_write+=("$GRAVITAS_DIR/runs")
  has_tier apps     && need_write+=("$APPS_DIR")
  has_tier residue  && need_write+=("$APP_SUPPORT")
  has_tier cache    && need_write+=("$APP_SUPPORT/Gravitas")

  local blocked=()
  local d
  for d in "${need_write[@]}"; do
    [ -e "$d" ] || continue
    can_write "$d" || blocked+=("$d")
  done

  if [ ${#blocked[@]} -eq 0 ]; then
    return 0
  fi

  printf '\n\033[1;31m════ 预检失败：以下路径不可写 ════\033[0m\n'
  for d in "${blocked[@]}"; do
    printf '  \033[31m✗\033[0m %s\n' "$d"
  done
  printf '\n\033[1m这通常意味着当前终端被沙箱限制了（例如应用内嵌终端）。\033[0m\n'
  printf '脚本逻辑本身没问题，但在这个终端里删不掉任何东西。\n\n'
  printf '请在 \033[1mmacOS 自带的「终端」或 iTerm\033[0m 中重新执行本脚本。\n'
  printf '可用下面的命令同时完成打开终端和执行：\n\n'
  printf '  open -a Terminal "%s"\n\n' "$SCRIPT_DIR"
  printf '若确认终端正常但仍不可写，可对 /Applications 部分使用 sudo：\n'
  printf '  bash %s --yes --tier=apps   # 失败时按提示加 sudo\n' "$(basename "$0")"
  printf '\n'
  logline "ABORT 预检失败，不可写路径: ${blocked[*]}"
  exit 3
}

preflight

FREE_BEFORE=$(df -h / | awk 'NR==2 {print $4}')

say()  { printf '%s\n' "$*"; }
head1() { printf '\n\033[1m%s\033[0m\n' "$*"; }
item() { printf '    %-58s %s\n' "$1" "$2"; }

# 删除目录：失败必须明确报错，不允许静默跳过
del_dir() {
  local path="$1"
  if [ ! -e "$path" ]; then
    logline "SKIP 不存在 $path"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '    [预演] rm -rf %s  (%s)\n' "$path" "$(du -sh "$path" 2>/dev/null | cut -f1)"
    logline "DRY  将删除 $path"
    return 0
  fi
  if rm -rf "$path" 2>/dev/null; then
    printf '    \033[32m[删除成功]\033[0m %s\n' "$path"
    logline "OK   已删除 $path"
  else
    printf '    \033[31m[删除失败]\033[0m %s\n' "$path"
    case "$path" in
      "$APPS_DIR"*)
        printf '         原因通常是 /Applications 需要管理员权限。请改用：\n'
        printf '         sudo rm -rf %s\n' "$path" ;;
      *)
        printf '         原因：权限不足或文件被占用。\n' ;;
    esac
    logline "FAIL 删除失败 $path"
    DEL_FAILED=$((DEL_FAILED + 1))
  fi
}

DEL_FAILED=0

app_running() { pgrep -f "Gravitas.app/Contents/MacOS/Gravitas" >/dev/null 2>&1; }

# ---------------- 启动信息 ----------------
printf '\033[1m================================================\033[0m\n'
if [ "$DRY_RUN" = "1" ]; then
  printf '\033[1m Gravitas 空间清理 — 预演模式（不删除任何文件）\033[0m\n'
else
  printf '\033[1m Gravitas 空间清理 — 实际执行\033[0m\n'
fi
printf ' 清理项: %s\n' "$TIERS"
printf ' 当前可用空间: %s\n' "$FREE_BEFORE"
printf '\033[1m================================================\033[0m\n'
logline "START 模式=$([ "$DRY_RUN" = "1" ] && echo 预演 || echo 执行) 项=$TIERS 可用=$FREE_BEFORE"

# =========================================================
# T1  ma-media-crawler 重复虚拟环境
# =========================================================
if has_tier venv; then
  head1 "[T1] ma-media-crawler 重复的 Python 虚拟环境"
  say "     同一个 skill 在 18 个工作区各装了一份 .venv，每份 501MB，内容完全相同。"
  say "     只删除 .venv，保留 SKILL.md 与源码；可用 uv sync 重建。"
  say ""

  VENV_LIST=$(find "$GRAVITAS_DIR/agent-workspaces" \
                -type d -name ".venv" \
                -path "*/ma-media-crawler/MediaCrawler/.venv" 2>/dev/null | sort)

  if [ -z "$VENV_LIST" ]; then
    say "     未找到匹配的 .venv，跳过。"
  else
    COUNT=0
    OK_COUNT=0
    while IFS= read -r v; do
      [ -z "$v" ] && continue
      COUNT=$((COUNT + 1))
      REL=${v#"$GRAVITAS_DIR/agent-workspaces/"}
      item "${REL%/.venv}" "$(du -sh "$v" 2>/dev/null | cut -f1)"
      if [ "$DRY_RUN" = "0" ]; then
        if rm -rf "$v" 2>/dev/null; then
          OK_COUNT=$((OK_COUNT + 1))
          logline "OK   已删除 $v"
        else
          printf '    \033[31m[删除失败]\033[0m %s\n' "$v"
          logline "FAIL 删除失败 $v"
          DEL_FAILED=$((DEL_FAILED + 1))
        fi
      else
        logline "DRY  将删除 $v"
      fi
    done <<< "$VENV_LIST"
    say ""
    if [ "$DRY_RUN" = "1" ]; then
      say "     共 $COUNT 份，将回收约 $(du -ck $VENV_LIST 2>/dev/null | tail -1 | awk '{printf "%.1f", $1/1024/1024}') GB"
    else
      say "     成功删除 $OK_COUNT / $COUNT 份虚拟环境"
    fi
    say ""
    say "     重建方式（需要用到该 skill 时执行）："
    say "       cd <工作区>/skills/ma-media-crawler/MediaCrawler && uv sync"
  fi
fi

# =========================================================
# T2  /Applications 旧版本副本
# =========================================================
if has_tier apps; then
  head1 "[T2] /Applications 旧版本 app 副本"
  say "     保留：$(IFS='、'; echo "${APPS_KEEP[*]}")"
  say "     其余 Gravitas*.app 副本全部清理（通配匹配，自动包含后续新产生的备份）"
  say ""

  in_keep() {
    local name="$1"
    for k in "${APPS_KEEP[@]}"; do [ "$name" = "$k" ] && return 0; done
    return 1
  }

  shopt -s nullglob
  APPS_TO_DELETE=()
  for p in "$APPS_DIR"/$APPS_GLOB_PATTERN; do
    [ -d "$p" ] || continue
    bn=$(basename "$p")
    if in_keep "$bn"; then
      item "[保留] $bn" "$(du -sh "$p" 2>/dev/null | cut -f1)"
    else
      item "$bn" "$(du -sh "$p" 2>/dev/null | cut -f1)"
      APPS_TO_DELETE+=("$p")
    fi
  done
  shopt -u nullglob

  say ""
  if [ ${#APPS_TO_DELETE[@]} -eq 0 ]; then
    say "     没有需要清理的副本。"
  else
    say "     共 ${#APPS_TO_DELETE[@]} 个待删，合计 $(du -ck "${APPS_TO_DELETE[@]}" 2>/dev/null | tail -1 | awk '{printf "%.1f GB", $1/1024/1024}')"
    say ""
    if app_running && [ "$DRY_RUN" = "0" ]; then
      say "     ⚠️  Gravitas 正在运行。删除的是其他副本，不影响当前进程，但建议先退出。"
    fi
    for p in "${APPS_TO_DELETE[@]}"; do
      del_dir "$p"
    done
  fi
fi

# =========================================================
# T3  审计日志轮转
# =========================================================
if has_tier audit; then
  head1 "[T3] config-audit 审计日志轮转"
  AUDIT="$GRAVITAS_DIR/config-audit/events.jsonl"
  if [ -f "$AUDIT" ]; then
    SZ=$(du -sh "$AUDIT" | cut -f1)
    LINES=$(wc -l < "$AUDIT" | tr -d ' ')
    item "events.jsonl" "$SZ / $LINES 行"
    say "     每行包含完整 settings 快照，因此单文件涨到 2.1GB。"
    ARCHIVE="$GRAVITAS_DIR/config-audit/events-$(date +%Y%m%d-%H%M).jsonl.gz"
    if [ "$DRY_RUN" = "1" ]; then
      printf '    [预演] gzip 归档为 %s，然后清空原文件\n' "$(basename "$ARCHIVE")"
    else
      echo "     压缩中（约需 1-2 分钟）..."
      if gzip -c "$AUDIT" > "$ARCHIVE"; then
        : > "$AUDIT"
        printf '    \033[32m[归档完成]\033[0m %s (%s)，events.jsonl 已清空\n' \
          "$(basename "$ARCHIVE")" "$(du -sh "$ARCHIVE" 2>/dev/null | cut -f1)"
        logline "OK   归档 $ARCHIVE"
      else
        printf '    \033[31m[归档失败]\033[0m 原文件未修改\n'
        logline "FAIL 归档失败 $AUDIT"
        DEL_FAILED=$((DEL_FAILED + 1))
        rm -f "$ARCHIVE"
      fi
    fi
  else
    say "     未找到 events.jsonl，跳过。"
  fi
fi

# =========================================================
# T4  历史 run 日志压缩
# =========================================================
if has_tier runs; then
  head1 "[T4] 历史 run 事件日志压缩"
  say "     只压缩 8-10 月，当前月份（11）正在写入，不处理。"
  say ""
  for m in 2026-08 2026-09 2026-10; do
    f="$GRAVITAS_DIR/runs/$m.jsonl"
    if [ -f "$f" ]; then
      item "$m.jsonl" "$(du -sh "$f" | cut -f1)"
      if [ "$DRY_RUN" = "1" ]; then
        printf '    [预演] gzip %s\n' "$(basename "$f")"
      else
        gzip "$f" && printf '    [压缩] %s.jsonl -> %s.jsonl.gz (%s)\n' \
          "$m" "$m" "$(du -sh "$f.gz" 2>/dev/null | cut -f1)"
      fi
    fi
  done
fi

# =========================================================
# T5  Application Support 残留
# =========================================================
if has_tier residue; then
  head1 "[T5] Application Support 历史残留"
  say "     保留：Gravitas（当前使用）、Gravitas Dev（开发版）"
  say ""
  # Owner Test 系列
  shopt -s nullglob
  for d in "$APP_SUPPORT"/Gravitas\ Owner*; do
    [ -d "$d" ] || continue
    item "$(basename "$d")" "$(du -sh "$d" 2>/dev/null | cut -f1)"
  done
  # 指定残留
  for name in "${RESIDUE_DIRS[@]}"; do
    d="$APP_SUPPORT/$name"
    [ -d "$d" ] || continue
    item "$name" "$(du -sh "$d" 2>/dev/null | cut -f1)"
  done
  say ""
  for d in "$APP_SUPPORT"/Gravitas\ Owner*; do
    [ -d "$d" ] || continue
    del_dir "$d"
  done
  for name in "${RESIDUE_DIRS[@]}"; do
    d="$APP_SUPPORT/$name"
    [ -d "$d" ] || continue
    del_dir "$d"
  done
  shopt -u nullglob
fi

# =========================================================
# T6  Chromium 缓存
# =========================================================
if has_tier cache; then
  head1 "[T6] Chromium 缓存（会自动重建）"
  if app_running; then
    say "     ⚠️  Gravitas 正在运行，缓存文件被占用，可能删除失败或导致异常。"
    say "         建议先退出应用再执行本项。"
    say ""
  fi
  for rel in "Cache" "Code Cache" "GPUCache" "Service Worker/CacheStorage"; do
    d="$APP_SUPPORT/Gravitas/$rel"
    if [ -d "$d" ]; then
      item "$rel" "$(du -sh "$d" 2>/dev/null | cut -f1)"
    fi
  done
  say ""
  if [ "$DRY_RUN" = "0" ] && app_running; then
    say "     已跳过（应用运行中）。退出 Gravitas 后重新执行："
    say "       bash $0 --yes --tier=cache"
  else
    for rel in "Cache" "Code Cache" "GPUCache" "Service Worker/CacheStorage"; do
      d="$APP_SUPPORT/Gravitas/$rel"
      if [ -d "$d" ]; then del_dir "$d"; fi
    done
  fi
fi

# =========================================================
# 汇总
# =========================================================
FREE_AFTER=$(df -h / | awk 'NR==2 {print $4}')
printf '\n\033[1m================================================\033[0m\n'
if [ "$DRY_RUN" = "1" ]; then
  printf ' 预演结束，未删除任何文件。\n'
  printf ' 确认无误后执行：\n'
  printf '   bash %s --yes\n' "$(basename "$0")"
  printf '\n 只清理某一项：\n'
  printf '   bash %s --yes --tier=venv\n' "$(basename "$0")"
else
  if [ "$DEL_FAILED" -gt 0 ]; then
    printf ' \033[31m完成，但有 %s 项失败\033[0m（见上方红色行）\n' "$DEL_FAILED"
  else
    printf ' \033[32m全部清理成功\033[0m\n'
  fi
  printf ' 可用空间: %s  ->  %s\n' "$FREE_BEFORE" "$FREE_AFTER"
  printf '\n 提示：如果刚清理了缓存，首次启动 Gravitas 会稍慢，属正常重建。\n'
fi
printf ' 记录日志: %s\n' "$LOG_FILE"
printf '\033[1m================================================\033[0m\n'
logline "END   可用空间 $FREE_BEFORE -> $FREE_AFTER，失败 $DEL_FAILED 项"
