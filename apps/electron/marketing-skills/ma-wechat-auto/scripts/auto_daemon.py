#!/usr/bin/env python3
"""微信达人自动回复守护进程（全自动定时跑）。

策略：低风险话术（破冰/介绍/邀约/索要报价表/内部反馈等）**自动发送**；
涉及 报价 / 返点 / 档期 / 寄样 / 合同 / 转账 等敏感环节一律**写入挂起队列**，等人工确认。

用法:
  python3 auto_daemon.py --start             # ★ 后台启动（脱离终端，立即返回）
  python3 auto_daemon.py --status            # 查看运行状态 + 最近日志
  python3 auto_daemon.py --stop              # 停止守护进程
  python3 auto_daemon.py --once              # 只跑一轮（前台，验证用）
  python3 auto_daemon.py --once --dry        # 只生成草稿，绝不发送
  python3 auto_daemon.py                     # 前台持续定时跑（挂终端，调试用）

配置: <工作区>/workspace-files/wechat-auto/state/daemon_config.json
日志: .../state/daemon.log    挂起: .../state/holds.json + .../state/holds.md
"""
import argparse
import json
import os
import random
import re
import signal
import subprocess
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wx  # noqa: E402
import paths  # noqa: E402

STATE = paths.STATE
CONFIG = paths.CONFIG
HOLDS = paths.HOLDS
HOLDS_MD = paths.HOLDS_MD
LOG = paths.DAEMON_LOG
STOP = paths.STOP_FILE
PID = paths.PID_FILE

DEFAULT_CONFIG = {
    "watch": [],
    "interval_seconds": 600,
    "interval_jitter": 0.3,
    "reply_delay_seconds": [15, 90],
    "n_messages": 14,
    "model": "claude-sonnet-4-5",
    "quiet_hours": [1, 8],
    "max_rounds": 0,
    # 留空则回退到环境变量 ANTHROPIC_API_KEY（命令行直接跑时用）。
    # 桌面 App 内由宿主写入，见 decide_reply 注释。
    "api_key": "",
    "base_url": "",
    # 自动发送总开关：默认关闭。开启后才会真正调用 send_message，
    # 否则只生成草稿写入挂起队列等人工确认。
    "auto_send": False,
}

_RUNNING = True


def log(msg):
    line = f"[{datetime.now():%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    os.makedirs(STATE, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_config():
    if not os.path.exists(CONFIG):
        os.makedirs(STATE, exist_ok=True)
        with open(CONFIG, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        log(f"已生成默认配置 {CONFIG}，请填写 watch 与 interval 后重跑")
    with open(CONFIG, encoding="utf-8") as f:
        cfg = {**DEFAULT_CONFIG, **json.load(f)}
    return cfg


def load_persona():
    """话术唯一来源：内置技能 `ma-kol-outreach/SKILL.md`（与本技能同级装在 skills/ 下，
    工作区若自建同名技能则读工作区那份）。
    统一剥离 YAML frontmatter。"""
    path = paths.persona_path()
    with open(path, encoding="utf-8") as f:
        txt = f.read()
    if txt.startswith("---"):
        parts = txt.split("---", 2)
        if len(parts) >= 3:
            txt = parts[2].lstrip("\n")
    return txt


OUTPUT_SPEC = """

---
# 输出格式（**必须严格 JSON**，不要任何多余文字、不要 markdown 代码块）
{"stage": "<当前阶段>", "risk": "low|high", "reply": "<可直接发送的话>", "note": "<给人工看的说明>"}

- `risk=high`：确认/讨论 **最终报价、返点比例、档期、寄样、合同、转账**，以及任何涉及**金额或承诺**的内容 → 一律 high。
- `risk=low`：破冰、自我介绍、品牌介绍、邀约、索要报价表、收到报价表后的回应、内部反馈、闲聊承接。
- 只回应「对方」的最后一条消息；`reply` 是要发出去的原话。
"""


def build_transcript(msgs):
    lines = []
    for m in msgs:
        who = "我方" if m["dir"] == "out" else "对方"
        lines.append(f"{who}: {m['text']}")
    return "\n".join(lines)


def _text_of(resp):
    return "".join(getattr(b, "text", "") for b in resp.content if hasattr(b, "text")).strip()


def decide_reply(persona, msgs, model, api_key=None, base_url=None):
    """调 LLM 生成回复并判定风险。返回 dict 或 None。

    api_key / base_url 从 daemon_config.json 读取（见 DEFAULT_CONFIG）。
    桌面 App 里没有 ANTHROPIC_API_KEY 环境变量——Agent 的 key 存在加密的
    channels.json 中，由宿主注入到配置里。两者都为空时回退到 SDK 默认
    （读环境变量），保持命令行直接可用的兼容性。
    """
    from anthropic import Anthropic

    client_kwargs = {}
    if api_key:
        client_kwargs["api_key"] = api_key
    if base_url:
        client_kwargs["base_url"] = base_url
    client = Anthropic(**client_kwargs)
    user = "以下是和某位达人的微信对话（最后一条来自对方，需要你回复）：\n\n" + build_transcript(msgs)
    resp = client.messages.create(
        model=model,
        max_tokens=1024,
        system=persona + OUTPUT_SPEC,
        messages=[{"role": "user", "content": user}],
    )
    raw = _text_of(resp)
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return {"stage": "?", "risk": "high", "reply": "", "note": f"模型输出无法解析: {raw[:120]}"}
    try:
        return json.loads(m.group(0))
    except Exception as e:
        return {"stage": "?", "risk": "high", "reply": "", "note": f"JSON 解析失败: {e}; raw={raw[:120]}"}


def add_hold(contact, decision, msgs):
    os.makedirs(STATE, exist_ok=True)
    holds = []
    if os.path.exists(HOLDS):
        with open(HOLDS, encoding="utf-8") as f:
            holds = json.load(f)
    item = {
        "time": f"{datetime.now():%Y-%m-%d %H:%M:%S}",
        "contact": contact,
        "stage": decision.get("stage"),
        "draft": decision.get("reply"),
        "note": decision.get("note"),
        "context": [f"{'我方' if m['dir'] == 'out' else '对方'}: {m['text']}" for m in msgs[-4:]],
        "handled": False,
    }
    holds.append(item)
    with open(HOLDS, "w", encoding="utf-8") as f:
        json.dump(holds, f, ensure_ascii=False, indent=2)
    # 人类可读版
    pend = [h for h in holds if not h["handled"]]
    with open(HOLDS_MD, "w", encoding="utf-8") as f:
        f.write(f"# 待人工确认（{len(pend)} 条）\n\n")
        for h in pend:
            f.write(f"## {h['time']} · {h['contact']} · 阶段 {h['stage']}\n")
            f.write(f"**草稿**：{h['draft']}\n\n")
            if h.get("note"):
                f.write(f"**说明**：{h['note']}\n\n")
            f.write("**上下文**：\n")
            for c in h["context"]:
                f.write(f"- {c}\n")
            f.write("\n---\n\n")
    log(f"  已挂起待确认：{contact}（阶段 {decision.get('stage')}）")
    return item


def run_round(cfg, dry=False, skip_delay=False):
    """跑一轮：检测 → 读取 → 决策 → 发送或挂起。返回本轮处理数。"""
    contacts = cfg["watch"]
    if not contacts:
        log("watch 为空，跳过（请在 daemon_config.json 里填写观察对象）")
        return 0
    base_file = f"{STATE}/poll_baseline.json"
    base = {}
    if os.path.exists(base_file):
        with open(base_file, encoding="utf-8") as f:
            base = json.load(f)

    persona = load_persona()
    acted = 0
    for c in contacts:
        if not _RUNNING:
            break
        prev = wx.session_preview(c)
        old = base.get(c)
        if prev is not None and prev != old:
            time.sleep(0.6)
            again = wx.session_preview(c)
            if again is not None:
                prev = again
        if prev is None or prev == old:
            continue

        msgs = wx.read_chat(c, cfg["n_messages"], convert_voice=True)
        base[c] = wx.session_preview(c)
        with open(base_file, "w", encoding="utf-8") as f:
            json.dump(base, f, ensure_ascii=False, indent=2)

        if not msgs or msgs[-1]["dir"] != "in":
            log(f"{c}: 有更新但最后一条是我方，跳过")
            continue

        log(f"{c}: 检测到对方新消息，生成回复…")
        try:
            d = decide_reply(
                persona,
                msgs,
                cfg["model"],
                api_key=cfg.get("api_key") or None,
                base_url=cfg.get("base_url") or None,
            )
        except Exception as e:
            log(f"  LLM 调用失败：{type(e).__name__} {str(e)[:160]}")
            continue

        risk = str(d.get("risk", "high")).lower()
        reply = (d.get("reply") or "").strip()
        log(f"  阶段={d.get('stage')} risk={risk} 草稿={reply!r}")

        if risk != "low" or not reply:
            add_hold(c, d, msgs)
            acted += 1
            continue

        # 自动发送总开关：默认关闭。未开启时即使 risk=low 也只入挂起队列，
        # 由人工确认后手动发——坐标点击失败会静默发错人，不可逆。
        if not cfg.get("auto_send", False):
            add_hold(
                c,
                {**d, "note": (d.get("note") or "") + "（auto_send 未开启，待人工确认）"},
                msgs,
            )
            acted += 1
            continue

        if dry:
            add_hold(c, {**d, "note": (d.get("note") or "") + "（dry-run，未发送）"}, msgs)
            acted += 1
            continue

        if not skip_delay:
            lo, hi = cfg["reply_delay_seconds"]
            wait = random.randint(int(lo), int(hi))
            log(f"  低风险，模拟真人延迟 {wait}s 后发送")
            time.sleep(wait)
        ok = wx.send_message(c, reply)
        log(f"  自动发送{'成功' if ok else '失败'}：{c} -> {reply!r}")
        acted += 1
    return acted


def in_quiet_hours(qh):
    h = datetime.now().hour
    lo, hi = qh
    return lo <= h < hi if lo <= hi else (h >= lo or h < hi)


# ---------------- 后台运行管理（供 Agent 通过 Bash 调用） ----------------
def _read_pid():
    try:
        with open(PID, encoding="utf-8") as f:
            return int(f.read().strip())
    except Exception:
        return None


def _alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _clear_pid():
    if _read_pid() == os.getpid() and os.path.exists(PID):
        os.remove(PID)


def start_background(extra):
    """脱离终端启动守护进程，父进程立即返回（start_new_session 使其不受父进程退出影响）。

    子进程的 stdout/stderr 单独落到 `daemon.stdio.log`——`log()` 已经写过 `daemon.log`，
    不能再把 stdout 也重定向到同一个文件，否则每行日志会重复两遍。"""
    paths.ensure_state()
    if os.path.exists(STOP):
        os.remove(STOP)
    stdio = open(paths.DAEMON_STDIO, "a", encoding="utf-8")
    try:
        child = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), *extra],
            stdout=stdio,
            stderr=stdio,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    finally:
        stdio.close()
    with open(PID, "w", encoding="utf-8") as f:
        f.write(str(child.pid))
    return child.pid


def show_status():
    pid = _read_pid()
    if _alive(pid):
        print(f"守护进程：运行中（pid={pid}）")
    elif pid:
        print(f"守护进程：未运行（pid 文件残留 pid={pid}，可安全忽略）")
    else:
        print("守护进程：未运行")
    print(f"话术来源：{paths.persona_path()}")
    if os.path.exists(LOG):
        with open(LOG, encoding="utf-8") as f:
            tail = f.readlines()[-5:]
        print("最近日志：")
        for line in tail:
            print("  " + line.rstrip())


def main():
    global _RUNNING
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", action="store_true", help="后台启动（脱离终端，立即返回）")
    ap.add_argument("--status", action="store_true", help="查看运行状态与最近日志")
    ap.add_argument("--stop", action="store_true", help="停止守护进程")
    ap.add_argument("--once", action="store_true", help="只跑一轮（前台）")
    ap.add_argument("--dry", action="store_true", help="只生成草稿，绝不发送")
    ap.add_argument("--no-delay", action="store_true", help="跳过发送前随机延迟")
    args = ap.parse_args()

    if args.status:
        show_status()
        return

    if args.start:
        extra = []
        if args.dry:
            extra.append("--dry")
        if args.no_delay:
            extra.append("--no-delay")
        pid = start_background(extra)
        print(f"已在后台启动守护进程 pid={pid}，日志：{LOG}")
        return

    if args.stop:
        paths.ensure_state()
        pid = _read_pid()
        if os.path.exists(PID):
            os.remove(PID)
        if _alive(pid):
            # 有 pid：SIGTERM 最可靠，不留停止标记（否则下次前台启动会误判为"收到停止标记"直接退出）
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            print(f"已停止守护进程（pid={pid}）")
        else:
            # 兜底：没有 pid（前台运行）时用停止标记
            open(STOP, "w").close()
            print("已创建停止标记，守护进程会在本轮结束后退出")
        return

    def _sig(signum, frame):
        global _RUNNING
        _RUNNING = False
        log("收到停止信号，本轮结束后退出")

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    cfg = load_config()
    if args.once:
        n = run_round(cfg, dry=args.dry, skip_delay=args.no_delay or args.dry)
        log(f"单轮结束，处理 {n} 个会话")
        return

    log(f"守护进程启动：观察 {cfg['watch']}，间隔 {cfg['interval_seconds']}s，"
        f"静默时段 {cfg['quiet_hours']}，模式={'dry(只挂起)' if args.dry else 'auto'}")
    log(f"话术来源：{paths.persona_path()}")
    rounds = 0
    try:
        while _RUNNING:
            if os.path.exists(STOP):
                os.remove(STOP)
                log("检测到停止标记，退出")
                break
            if in_quiet_hours(cfg["quiet_hours"]):
                log("静默时段，跳过本轮")
            else:
                try:
                    run_round(cfg, dry=args.dry, skip_delay=args.no_delay)
                except Exception as e:
                    log(f"本轮异常：{type(e).__name__} {str(e)[:200]}")
            rounds += 1
            if cfg.get("max_rounds") and rounds >= cfg["max_rounds"]:
                log(f"达到 max_rounds={cfg['max_rounds']}，退出")
                break
            iv = cfg["interval_seconds"] * (1 + random.uniform(-cfg["interval_jitter"], cfg["interval_jitter"]))
            log(f"本轮结束，{iv:.0f}s 后再跑")
            slept = 0
            while _RUNNING and slept < iv:
                time.sleep(min(5, iv - slept))
                slept += 5
    finally:
        _clear_pid()
    log("守护进程退出")


if __name__ == "__main__":
    main()
