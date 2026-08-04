#!/usr/bin/env bash
# =============================================================================
# 手动同步官方 Proma 资产 → proma-mit 应用（多工作区版）
#
# 背景：proma-mit 与官方 Proma 是两个独立应用（配置目录 ~/.proma-mit/ 与 ~/.proma/）。
#   用户主要在官方 Proma 里积累项目/Skills/CLAUDE.md 等资产，需要同步到 proma-mit。
#   这是**手动**脚本，不做成应用功能，避免在未安装官方 Proma 的电脑上产生冗余检查。
#
# 用法：
#   bash scripts/sync-upstream-assets.sh            # 同步
#   bash scripts/sync-upstream-assets.sh --dry-run  # 只预览差异，不写入
#
# 同步内容：
#   [1] 项目工作区：官方索引（~/.proma/agent-workspaces.json）中带 projectRootPath
#       的工作区（paa / ma-proma / proma-mit / OptiMed 等）→ 注册/更新 proma-mit
#       工作区索引（rootPath 指向项目根目录），并同步其 skills / CLAUDE.md /
#       .claude-plugin / skills-inactive 资产
#   [2] 全局 default-skills 模板 → proma-mit default-skills
#   [3] 可选：chat-tools.json（工具开关）、memory.json（记忆配置）
#
# 原则：只增/覆盖，不删除本地多余内容；幂等；仅读取官方数据，不写回。
# =============================================================================

set -euo pipefail

MODE="${1:-sync}"
if [[ "$MODE" != "sync" && "$MODE" != "--dry-run" ]]; then
  echo "用法: $0 [sync|--dry-run]" >&2
  exit 2
fi

UPSTREAM_INDEX="${UPSTREAM_PROMA_INDEX:-$HOME/.proma/agent-workspaces.json}"
UPSTREAM_WS_ROOT="${UPSTREAM_PROMA_WS_ROOT:-$HOME/.proma/agent-workspaces}"
TARGET_INDEX="${PROMA_MIT_INDEX:-$HOME/.proma-mit/agent-workspaces.json}"
TARGET_WS_ROOT="${PROMA_MIT_WS_ROOT:-$HOME/.proma-mit/agent-workspaces}"
DRY_RUN="$MODE"

if [[ ! -f "$UPSTREAM_INDEX" ]]; then
  echo "[提示] 未发现官方 Proma 工作区索引: $UPSTREAM_INDEX"
  echo "       本机可能未安装/未使用官方 Proma，无需同步（属正常情况）。"
  exit 0
fi

echo "==== 同步官方 Proma 资产 → proma-mit（多工作区）===="
echo "模式: $MODE"
echo ""

UPSTREAM_INDEX="$UPSTREAM_INDEX" \
UPSTREAM_WS_ROOT="$UPSTREAM_WS_ROOT" \
TARGET_INDEX="$TARGET_INDEX" \
TARGET_WS_ROOT="$TARGET_WS_ROOT" \
DRY_RUN="$DRY_RUN" \
python3 << 'PYEOF'
import json, os, sys, uuid, time, shutil, subprocess

upstream_index = os.environ["UPSTREAM_INDEX"]
upstream_root = os.environ["UPSTREAM_WS_ROOT"]
target_index = os.environ["TARGET_INDEX"]
target_root = os.environ["TARGET_WS_ROOT"]
dry_run = os.environ["DRY_RUN"] == "--dry-run"

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"version": 2, "workspaces": []}

def sync_dir(src, dst, label):
    """rsync 增量同步：checksum 比较，不删除本地多余内容"""
    if not os.path.isdir(src):
        print(f"    [跳过] {label}：源目录不存在")
        return
    os.makedirs(dst, exist_ok=True)
    if dry_run:
        try:
            r = subprocess.run(
                ["rsync", "--archive", "--checksum", "--itemize-changes", "--dry-run", src + "/", dst + "/"],
                capture_output=True, text=True, timeout=60,
            )
            diff = sum(1 for line in r.stdout.splitlines() if line.startswith(">f"))
            print(f"    [dry-run] {label} → 差异文件 {diff} 个")
        except Exception:
            print(f"    [dry-run] {label} → 需检查")
    else:
        subprocess.run(["rsync", "--archive", "--checksum", src + "/", dst + "/"], check=True, timeout=300)
        print(f"    [同步] {label}")

def copy_if_exists(src, dst, label):
    if os.path.exists(src):
        if dry_run:
            print(f"    [dry-run] {label}")
        else:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
            print(f"    [同步] {label}")

# ─── [1] 项目工作区：注册 rootPath 映射 ───
print("── [1] 项目工作区 ──")
upstream = load(upstream_index)
target = load(target_index)

project_ws = [w for w in upstream.get("workspaces", []) if (w.get("projectRootPath") or w.get("rootPath")) and (w.get("name") or "").strip()]
changed = False

for ws in project_ws:
    name = (ws.get("name") or "").strip()
    root = ((ws.get("projectRootPath") or ws.get("rootPath") or "")).strip()
    if not root or not os.path.isdir(root):
        print(f"  [跳过] {name or root}（项目目录不存在）")
        continue
    root = os.path.realpath(root)

    existing = next(
        (w for w in target.get("workspaces", [])
         if (w.get("rootPath") and os.path.realpath(w["rootPath"]) == root) or w.get("name") == name),
        None,
    )
    if existing:
        print(f"  [已有] {name} (slug={existing['slug']}) → {root}")
        continue

    if dry_run:
        print(f"  [dry-run] 将注册工作区: {name} → {root}")
        continue

    slug = (ws.get("slug") or name.lower()).strip() or f"ws-{int(time.time())}"
    existing_slugs = {w.get("slug") for w in target.get("workspaces", [])}
    base, i = slug, 1
    while slug in existing_slugs:
        slug = f"{base}-{i}"
        i += 1
    now = int(time.time() * 1000)
    target["workspaces"].insert(0, {
        "id": str(uuid.uuid4()),
        "name": name,
        "slug": slug,
        "rootPath": root,
        "createdAt": now,
        "updatedAt": now,
    })
    changed = True
    print(f"  [注册] {name} (slug={slug}) → {root}")

if not dry_run and changed:
    os.makedirs(os.path.dirname(target_index), exist_ok=True)
    if os.path.exists(target_index):
        shutil.copy2(target_index, target_index + ".bak")
    with open(target_index, "w") as f:
        json.dump(target, f, ensure_ascii=False, indent=2)
    print(f"  [索引] 已更新: {target_index}")

# ─── [2] 各工作区资产同步 ───
print("")
print("── [2] 项目工作区资产同步 ──")
target_slugs = {w.get("slug") for w in target.get("workspaces", [])}
# 只同步官方带本地项目根目录的工作区（项目工作区），纯会话工作区不同步
project_slugs = {w.get("slug") for w in upstream.get("workspaces", []) if (w.get("projectRootPath") or w.get("rootPath"))}
synced_any = False
for ws in upstream.get("workspaces", []):
    slug = ws.get("slug", "")
    name = ws.get("name", "")
    if not slug or slug not in target_slugs or slug not in project_slugs:
        continue
    src = os.path.join(upstream_root, slug)
    dst = os.path.join(target_root, slug)
    if not os.path.isdir(src):
        continue
    synced_any = True
    print(f"  [{name}]")
    sync_dir(os.path.join(src, "skills"), os.path.join(dst, "skills"), "skills/")
    sync_dir(os.path.join(src, "skills-inactive"), os.path.join(dst, "skills-inactive"), "skills-inactive/")
    copy_if_exists(os.path.join(src, "CLAUDE.md"), os.path.join(dst, "CLAUDE.md"), "CLAUDE.md")
    copy_if_exists(os.path.join(src, ".claude-plugin"), os.path.join(dst, ".claude-plugin"), ".claude-plugin/")
if not synced_any:
    print("  （无待同步项目工作区）")

# ─── [3] 全局资产 ───
print("")
print("── [3] 全局资产 ──")
sync_dir(os.path.join(os.path.expanduser("~/.proma"), "default-skills"), os.path.join(os.path.expanduser("~/.proma-mit"), "default-skills"), "default-skills 模板")
copy_if_exists(os.path.expanduser("~/.proma/chat-tools.json"), os.path.expanduser("~/.proma-mit/chat-tools.json"), "chat-tools.json（工具开关）")
copy_if_exists(os.path.expanduser("~/.proma/memory.json"), os.path.expanduser("~/.proma-mit/memory.json"), "memory.json（记忆配置）")

print("")
print("==== 同步完成 ====" if not dry_run else "==== 预览结束（未写入任何文件）====")
PYEOF
