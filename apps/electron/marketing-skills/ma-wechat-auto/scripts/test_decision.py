#!/usr/bin/env python3
"""用合成对话验证决策逻辑：风险分级是否正确 + 话术是否像人。**不触碰微信。**"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import auto_daemon as D  # noqa: E402

CASES = [
    ("情况②·达人回应开场", "low", [("out", "哈咯哈咯小宝，我是忘本甄果的 pr zhangzhang～"), ("in", "哈喽哈喽")]),
    ("情况②·达人发了主页链接", "low", [("out", "辛苦发一下咱们的主页链接呐～🙋"), ("in", "好滴 这是我的主页 https://xhslink.com/abc")]),
    ("流程·已报价待反馈", "low", [("out", "报价收到啦！我们内部评估一下，3天内给你反馈哈～"), ("in", "好哒 等你消息")]),
    ("闲聊承接", "low", [("in", "哈哈哈最近真的好热啊")]),
    ("情况①·达人给出报价数字", "high", [("in", "宝子 我图文报价5000 返30 你看行不")]),
    ("返点·达人给出返点", "high", [("out", "咱们这边走报备的话返点是多少呀？"), ("in", "报备返点15个点")]),
    ("返点·达人索要返点", "high", [("in", "你们这边返点能给到多少呀")]),
    ("档期·达人确认日期", "high", [("in", "9月20号我可以 就这天发吧")]),
    ("提报·达人问结果", "high", [("out", "我去跟品牌提报一下，有结果第一时间通知你～"), ("in", "好的 品牌那边有结果了吗")]),
]


def main():
    persona = D.load_persona()
    model = "claude-sonnet-4-6"
    ok = 0
    for name, expect, conv in CASES:
        msgs = [{"dir": d, "text": t} for d, t in conv]
        dec = D.decide_reply(persona, msgs, model)
        risk = str(dec.get("risk", "?")).lower()
        flag = "✅" if risk == expect else "❌"
        if risk == expect:
            ok += 1
        print(f"{flag} [{name}] 期望={expect} 实际={risk} 阶段={dec.get('stage')}")
        print(f"     草稿: {dec.get('reply')!r}")
        if dec.get("note"):
            print(f"     说明: {dec.get('note')!r}")
    print(f"\n风险分级正确: {ok}/{len(CASES)}")


if __name__ == "__main__":
    main()
