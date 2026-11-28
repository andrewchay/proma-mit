#!/usr/bin/env python3
"""轮询观察对象的会话：找出有新消息的，读取对话（含语音转文字），输出结构化结果。
**本脚本不发送任何消息**——回复由 agent 按 skills/ma-kol-outreach 话术生成后再单独 send。

用法:
  python3 poll_replies.py                                  # 用台账里「已添加」的达人
  python3 poll_replies.py --watch "焦糖布丁" "董洁 whytdxy"   # 指定观察对象
  python3 poll_replies.py --force                          # 忽略预览基线，全部重读
  python3 poll_replies.py --json                           # 输出 JSON（供程序消费）
"""
import argparse
import csv
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wx  # noqa: E402
import paths  # noqa: E402

LEDGER = paths.LEDGER
BASELINE = paths.BASELINE


def load_json(p):
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_json(p, d):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def ledger_added():
    if not os.path.exists(LEDGER):
        return []
    with open(LEDGER, encoding="utf-8") as f:
        return [
            r["达人昵称"]
            for r in csv.DictReader(f)
            if (r.get("加好友状态") or "").strip() == "已添加" and (r.get("达人昵称") or "").strip()
        ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--watch", nargs="+", help="要观察的联系人（微信显示名/备注名）")
    ap.add_argument("--force", action="store_true", help="忽略基线，全部重读")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("-n", type=int, default=14, help="每个会话读多少条")
    args = ap.parse_args()

    contacts = args.watch or ledger_added()
    if not contacts:
        print("没有可观察对象：台账里没有「已添加」的达人，也未指定 --watch")
        return

    base = load_json(BASELINE)
    results = []
    for c in contacts:
        prev = wx.session_preview(c)
        old = base.get(c)
        # 过滤 OCR 抖动造成的瞬时误报：疑似有变化时复读一次确认
        if not args.force and prev is not None and prev != old:
            time.sleep(0.6)
            again = wx.session_preview(c)
            if again is not None:
                prev = again
        changed = args.force or (prev is not None and prev != old)
        if not changed:
            results.append({"contact": c, "changed": False, "preview": prev})
            continue
        msgs = wx.read_chat(c, args.n, convert_voice=True)
        last = msgs[-1] if msgs else None
        results.append(
            {
                "contact": c,
                "changed": True,
                "preview": wx.session_preview(c),
                "needs_reply": bool(last and last["dir"] == "in"),
                "last": last,
                "messages": msgs,
            }
        )
        base[c] = wx.session_preview(c)
    save_json(BASELINE, base)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return
    for r in results:
        if not r["changed"]:
            print(f"— {r['contact']}：无新消息")
            continue
        tag = "需要回复" if r.get("needs_reply") else "最后是我方发出，无需回复"
        print(f"● {r['contact']}  [{tag}]")
        for m in r["messages"]:
            print(f"    {'→' if m['dir'] == 'out' else '←'} {m['text']}")


if __name__ == "__main__":
    main()
