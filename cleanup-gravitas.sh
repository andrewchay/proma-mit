#!/bin/bash
#
# Gravitas 空间清理脚本  (v2)
#
# 用法：
#   bash cleanup-gravitas.sh                  # 预演，只统计不删除
#   bash cleanup-gravitas.sh --yes            # 仅清理缓存
#   bash cleanup-gravitas.sh --yes --tier=cache        # 清理缓存
#   bash cleanup-gravitas.sh --list           # 列出所有清理项
#
# 建议：清理缓存类（T6）前先退出 Gravitas。
#
# 默认仅预演缓存清理；其他清理项已暂停。
# 不修改审计日志、历史运行记录或应用和用户数据目录。
#
set -uo pipefail

# ---------------- 配置 ----------------
# 下列路径支持环境变量覆盖，便于在沙箱中做自测。
GRAVITAS_DIR="${GRAVITAS_HOME_OVERRIDE:-$HOME/.gravitas}"
APP_SUPPORT="${GRAVITAS_APPSUPPORT_OVERRIDE:-$HOME/Library/Application Support}"
APPS_DIR="${GRAVITAS_APPS_DIR_OVERRIDE:-/Applications}"

# ---------------- 参数解析 ----------------
DRY_RUN=1
TIERS="cache"

for arg in "$@"; do
  case "$arg" in
    --yes|-y)      DRY_RUN=0 ;;
    --tier=*)      TIERS="${arg#--tier=}" ;;
    --list)
      echo "可用清理项：cache（默认）"
      echo "已暂停：venv、apps、audit、runs、residue"
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
touch "$LOG_FILE" 2>/dev/null || true
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

if [ "$DRY_RUN" = "0" ]; then preflight; fi

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
SKIPPED=0

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
# venv 暂停：工作区可能正在使用这些环境。
# =========================================================
if has_tier venv; then
  printf '[跳过] venv 尚无安全清理方案，不修改文件。\n'
  logline "SKIP venv 尚无安全清理方案"
  DEL_FAILED=$((DEL_FAILED + 1))
fi

# =========================================================
# apps 暂停：这些路径可能包含权威数据或用户保留的应用。
# =========================================================
if has_tier apps; then
  printf '[跳过] apps 尚无安全清理方案，不修改文件。\n'
  logline "SKIP apps 尚无安全清理方案"
  DEL_FAILED=$((DEL_FAILED + 1))
fi

# =========================================================
# audit 暂停：这些路径可能包含权威数据或用户保留的应用。
# =========================================================
if has_tier audit; then
  printf '[跳过] audit 尚无安全清理方案，不修改文件。\n'
  logline "SKIP audit 尚无安全清理方案"
  DEL_FAILED=$((DEL_FAILED + 1))
fi

# =========================================================
# runs 暂停：这些路径可能包含权威数据或用户保留的应用。
# =========================================================
if has_tier runs; then
  printf '[跳过] runs 尚无安全清理方案，不修改文件。\n'
  logline "SKIP runs 尚无安全清理方案"
  DEL_FAILED=$((DEL_FAILED + 1))
fi

# =========================================================
# residue 暂停：这些路径可能包含权威数据或用户保留的应用。
# =========================================================
if has_tier residue; then
  printf '[跳过] residue 尚无安全清理方案，不修改文件。\n'
  logline "SKIP residue 尚无安全清理方案"
  DEL_FAILED=$((DEL_FAILED + 1))
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
    SKIPPED=$((SKIPPED + 1))
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
  printf '   bash %s --yes --tier=cache\n' "$(basename "$0")"
else
  if [ "$DEL_FAILED" -gt 0 ]; then
    printf ' \033[31m完成，但有 %s 项失败\033[0m（见上方红色行）\n' "$DEL_FAILED"
  elif [ "$SKIPPED" -gt 0 ]; then
    printf ' 部分清理项已跳过。\n'
  else
    printf ' \033[32m全部清理成功\033[0m\n'
  fi
  printf ' 可用空间: %s  ->  %s\n' "$FREE_BEFORE" "$FREE_AFTER"
  printf '\n 提示：如果刚清理了缓存，首次启动 Gravitas 会稍慢，属正常重建。\n'
fi
printf ' 记录日志: %s\n' "$LOG_FILE"
printf '\033[1m================================================\033[0m\n'
logline "END   可用空间 $FREE_BEFORE -> ${FREE_AFTER}，失败 $DEL_FAILED 项"

if [ "$DEL_FAILED" -gt 0 ]; then exit 1; fi
