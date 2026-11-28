#!/usr/bin/env python3
"""检查已添加达人的会话是否有新消息（对比会话预览文本变化，不打开会话、不标记已读）。

用法:
  python3 check_new.py            # 打印有变化的达人
  python3 check_new.py --update   # 同时把最新预览写回台账
"""
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wx  # noqa: E402
import paths  # noqa: E402

LEDGER = paths.LEDGER


def session_map():
    """把会话列表 OCR 结果聚合成 [{name, preview, y}]。"""
    rows = sorted(wx.list_sessions(), key=lambda r: r["y"])
    groups, cur = [], []
    for r in rows:
        if cur and r["y"] - cur[-1]["y"] > 30:
            groups.append(cur)
            cur = []
        cur.append(r)
    if cur:
        groups.append(cur)
    out = []
    for g in groups:
        out.append(
            {
                "name": g[0]["text"],
                "preview": " ".join(x["text"] for x in g[1:]),
                "y": g[0]["y"],
            }
        )
    return out


def main():
    update = "--update" in sys.argv
    with open(LEDGER, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    fieldnames = list(rows[0].keys()) if rows else []

    smap = session_map()
    changed = []
    for r in rows:
        nick = (r.get("微信号") or "").strip()
        name = (r.get("达人昵称") or "").strip()
        if r.get("加好友状态") != "已添加":
            continue
        hit = None
        for s in smap:
            if (name and (name in s["name"] or s["name"] in name)) or (
                nick and nick in s["name"]
            ):
                hit = s
                break
        if not hit:
            print(f"[?] 会话列表中未找到：{name}（可能备注名不同，请更新台账「达人昵称」为微信备注名）")
            continue
        prev = (r.get("上次预览") or "").strip()
        if hit["preview"] != prev and hit["preview"]:
            changed.append((name, prev, hit["preview"]))
            r["上次预览"] = hit["preview"]
        if update:
            r["上次预览"] = hit["preview"]

    if changed:
        print("=== 有新动态的达人 ===")
        for name, prev, now in changed:
            print(f"  ● {name}\n      旧: {prev or '(空)'}\n      新: {now}")
    else:
        print("无新动态")

    if update and fieldnames:
        with open(LEDGER, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(rows)
        print("台账已更新")


if __name__ == "__main__":
    main()
