#!/usr/bin/env python3
"""开场消息发出后，监测对方是否回复；一旦回复即自动跟发一句（每人只跟一次，避免无限循环）。

判定方式：**会话列表预览文本变化**（不打开会话、不抢焦点）。
只有真正要跟发时才激活微信去发送。

用法:
  python3 auto_followup.py --message "我最爱你了宝贝" --minutes 30 "焦糖布丁" "董洁 whytdxy"
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wx  # noqa: E402
import paths  # noqa: E402

LOG = paths.FOLLOWUP_LOG


def log(msg):
    line = f"[{time.strftime('%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    paths.ensure_state()
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("contacts", nargs="+")
    ap.add_argument("--message", required=True)
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--interval", type=float, default=40)
    args = ap.parse_args()

    baseline = {}
    for c in args.contacts:
        baseline[c] = wx.session_preview(c)
        log(f"基线 {c}: {baseline[c]!r}")
    missing = [c for c in args.contacts if baseline[c] is None]
    if missing:
        log(f"⚠️ 未在会话列表找到（无法监测）: {missing}")

    done = set()
    deadline = time.time() + args.minutes * 60
    log(f"开始监测 {args.contacts}，最长 {args.minutes} 分钟，间隔 {args.interval}s")

    while time.time() < deadline and len(done) < len(args.contacts):
        for c in args.contacts:
            if c in done or baseline[c] is None:
                continue
            p = wx.session_preview(c)
            if p and p != baseline[c]:
                log(f"→ {c} 有新动态: {p!r}，跟发")
                ok = wx.send_message(c, args.message)
                log(f"  跟发{'成功' if ok else '失败'}: {c} -> {args.message!r}")
                if ok:
                    done.add(c)
                    baseline[c] = wx.session_preview(c)
        if len(done) < len(args.contacts):
            time.sleep(args.interval)

    log(f"结束。已跟发: {sorted(done)}；未回复: {sorted(set(args.contacts) - done)}")


if __name__ == "__main__":
    main()
