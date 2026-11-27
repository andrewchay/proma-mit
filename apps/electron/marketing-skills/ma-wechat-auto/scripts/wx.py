#!/usr/bin/env python3
"""macOS 微信 4.x 自动化核心库（无辅助功能树，走坐标+剪贴板+OCR）。

子命令:
  probe              探测窗口并截图
  ocr                截图并 OCR 输出所有文字及屏幕坐标
  sessions           列出会话列表（含未读标记）
  read  <联系人> [n]  读取某会话最近 n 条消息
  send  <联系人> <文本>  给联系人发送文本
  sendfile <联系人> <路径> 发送文件
"""
import os
import sys
import re
import json
import time
import subprocess
import Quartz
import Vision
from Foundation import NSURL
from AppKit import NSPasteboard, NSStringPboardType

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

_TIME_RE = re.compile(r"^[上下昨今前]?(午|晚|早|凌晨)?\s*\d{1,2}:\d{2}$|^\d{4}年\d{1,2}月\d{1,2}日")


def _is_time(t):
    return bool(_TIME_RE.match(t.strip()))


# 语音气泡：时长形如 8'' / 22" / ）) 11" / 4"(、 （OCR 会把波形/引号识成杂字符，故放宽）
_VOICE_RE = re.compile(r"^(?!.*[:：])[^\d]{0,4}\d{1,3}\s*[\"'“”‘’′`]{1,3}\D{0,3}$")


def _is_voice(t):
    return bool(_VOICE_RE.match(t.strip()))

# --- 键码 ---
K_A, K_F, K_V, K_N = 0, 3, 9, 45
K_ENTER, K_ESC, K_TAB = 36, 53, 48
K_1, K_2 = 18, 19

STATE_DIR = paths.STATE


# ---------------- 窗口 ----------------
_SKIP_WIN_NAME = ("窗口", "搜一搜", "搜索")


def find_main_window():
    """定位微信**主聊天窗口**。
    注意：打开「搜一搜」时会出现一个面积更大的窗口（名字含「搜一搜」/「窗口」），
    若只按面积取最大会选错窗口，故先按名字排除。"""
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly
        | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    cands = []
    for w in wins:
        owner = str(w.get("kCGWindowOwnerName", ""))
        if not ("微信" in owner or "WeChat" in owner):
            continue
        if w.get("kCGWindowLayer") != 0:
            continue
        name = str(w.get("kCGWindowName", "") or "")
        if any(s in name for s in _SKIP_WIN_NAME):
            continue
        cands.append(w)
    if not cands:
        return None
    exact = [w for w in cands if str(w.get("kCGWindowName", "")) == "微信"]
    pool = exact or cands
    pool.sort(
        key=lambda w: w["kCGWindowBounds"]["Width"] * w["kCGWindowBounds"]["Height"],
        reverse=True,
    )
    return pool[0]


def win_bounds():
    w = find_main_window()
    if not w:
        return None
    b = dict(w["kCGWindowBounds"])
    return w, (b["X"], b["Y"], b["Width"], b["Height"])


# 最小可用窗口尺寸。窗口过小时会话列表/输入框会被挤压，
# OCR 出的坐标过于密集，点击极易落到错误的会话或按钮上——
# 而这种失败是「静默发错人」，必须前置拦截而不是事后补救。
MIN_WINDOW_W = 700
MIN_WINDOW_H = 500


class WindowTooSmall(RuntimeError):
    """微信窗口尺寸不足，拒绝执行坐标操作。"""


def ensure_window():
    """确保微信主窗口已打开（被关掉/最小化时自动拉起）。"""
    if find_main_window() is None:
        subprocess.run(["open", "-a", "WeChat"], capture_output=True)
        time.sleep(2.5)


def require_usable_window():
    """取窗口并校验尺寸，不满足直接抛错（不做任何点击）。"""
    ensure_window()
    bounds = win_bounds()
    if bounds is None:
        raise RuntimeError(
            "未找到微信主窗口。请确认微信已启动并登录，然后重试。"
        )
    _w, (_x, _y, ww, wh) = bounds
    if ww < MIN_WINDOW_W or wh < MIN_WINDOW_H:
        raise WindowTooSmall(
            f"微信窗口当前为 {ww:.0f}x{wh:.0f}，小于最小要求 "
            f"{MIN_WINDOW_W}x{MIN_WINDOW_H}。\n"
            f"窗口过小时坐标点击容易落到错误位置（如发错联系人）。\n"
            f"请先把微信窗口拉大后重试。"
        )
    return bounds


def capture():
    _w, (x, y, ww, wh) = require_usable_window()
    img = Quartz.CGWindowListCreateImage(
        Quartz.CGRectNull,
        Quartz.kCGWindowListOptionIncludingWindow,
        int(_w["kCGWindowNumber"]),
        Quartz.kCGWindowImageBoundsIgnoreFraming,
    )
    return img, (x, y, ww, wh)


def capture_wid(wid):
    """按窗口 id 截图，返回 (img, bounds)。"""
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly
        | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    for w in wins:
        if int(w.get("kCGWindowNumber", -1)) == int(wid):
            b = dict(w["kCGWindowBounds"])
            img = Quartz.CGWindowListCreateImage(
                Quartz.CGRectNull,
                Quartz.kCGWindowListOptionIncludingWindow,
                int(wid),
                Quartz.kCGWindowImageBoundsIgnoreFraming,
            )
            return img, (b["X"], b["Y"], b["Width"], b["Height"])
    return None, None


def find_overlay():
    """搜索浮层窗口（layer 既不是 0 也不是菜单栏层）。"""
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly
        | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    best = None
    for w in wins:
        o = str(w.get("kCGWindowOwnerName", ""))
        if ("微信" in o or "WeChat" in o) and w.get("kCGWindowLayer") not in (0, 24, 25, 102):
            b = dict(w.get("kCGWindowBounds", {}))
            if b.get("Width", 0) > 150 and b.get("Height", 0) > 100:
                best = w
    return best


def save_png(img, path):
    paths.ensure_state()
    url = NSURL.fileURLWithPath_(path)
    dest = Quartz.CGImageDestinationCreateWithURL(url, "public.png", 1, None)
    Quartz.CGImageDestinationAddImage(dest, img, None)
    Quartz.CGImageDestinationFinalize(dest)


# ---------------- 输入 ----------------
# 注意：CGEventPost 注入的 Return 不被 WeChat 4.x 接受，
# 因此按键统一走 `osascript System Events key code`；鼠标走 cliclick。
CLICLICK = "/opt/homebrew/bin/cliclick"


def activate():
    subprocess.run(
        ["osascript", "-e", 'tell application "WeChat" to activate'],
        capture_output=True,
    )
    time.sleep(0.6)


def key(code, cmd=False, shift=False, alt=False):
    mods = []
    if cmd:
        mods.append("command down")
    if shift:
        mods.append("shift down")
    if alt:
        mods.append("option down")
    using = (" using {" + ", ".join(mods) + "}") if mods else ""
    subprocess.run(
        ["osascript", "-e", f'tell application "System Events" to key code {code}{using}'],
        capture_output=True,
    )
    time.sleep(0.08)


def click(x, y):
    subprocess.run([CLICLICK, f"c:{int(x)},{int(y)}"], capture_output=True)
    time.sleep(0.1)


def move(x, y):
    """只移动鼠标（用于触发 hover）。"""
    subprocess.run([CLICLICK, f"m:{int(x)},{int(y)}"], capture_output=True)
    time.sleep(0.08)


def set_clipboard(text):
    pb = NSPasteboard.generalPasteboard()
    pb.clearContents()
    pb.setString_forType_(text, NSStringPboardType)


def get_clipboard():
    return NSPasteboard.generalPasteboard().stringForType_(NSStringPboardType)


def paste_text(text):
    """通过剪贴板粘贴文本（避免中文/emoji 输入法乱码）。"""
    set_clipboard(text)
    time.sleep(0.08)
    key(K_V, cmd=True)
    time.sleep(0.15)


# ---------------- OCR ----------------
def ocr(img, ox=None, oy=None, ww=None):
    """返回 [(text, sx, sy, sw, sh)]，坐标已是屏幕点。可指定原点覆盖主窗口。"""
    if ox is None:
        _, (ox, oy, ww, _) = win_bounds()
    iw = Quartz.CGImageGetWidth(img)
    ih = Quartz.CGImageGetHeight(img)
    scale = iw / ww
    out = []

    def handler(request, error):
        if error:
            return
        for obs in request.results():
            top = obs.topCandidates_(1)
            if not top:
                continue
            bb = obs.boundingBox()
            px = bb.origin.x * iw
            py = (1 - bb.origin.y - bb.size.height) * ih
            out.append(
                (
                    top[0].string(),
                    ox + px / scale,
                    oy + py / scale,
                    bb.size.width * iw / scale,
                    bb.size.height * ih / scale,
                )
            )

    req = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(["zh-Hans", "en-US"])
    req.setUsesLanguageCorrection_(True)
    h = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(img, None)
    h.performRequests_error_([req], None)
    return out


# ---------------- 业务 ----------------
def find_session_row(name):
    """在会话列表中查找匹配 name 的行，返回点击坐标 (x, y) 或 None。"""
    img, win = capture()
    ox, oy, ww, wh = win
    left = content_left(win)
    rows = [r for r in ocr(img) if r[1] < left and r[1] > ox + 90 and r[2] > oy + 60]
    cand = [r for r in rows if name in r[0] or r[0] in name]
    if not cand:
        return None
    cand.sort(key=lambda r: r[2])
    r = cand[0]
    return (r[1] + 40, r[2])


def chat_title():
    """读取内容区顶部标题（当前打开会话的名称）。"""
    img, win = capture()
    ox, oy, ww, wh = win
    left = content_left(win)
    items = [r for r in ocr(img) if r[1] > left]
    items.sort(key=lambda r: r[2])
    for r in items:
        if r[2] < oy + 120:  # 标题区
            return r[0]
    return items[0][0] if items else None


def _title_ok(contact, t):
    return bool(t) and (contact in t or t in contact)


def search_box_point(win=None):
    """会话列表顶部搜索框内的点（相对窗口位置稳定）。"""
    if win is None:
        win = capture()[1]
    x, y, ww, wh = win
    return (x + 150, y + 27)


def open_chat_by_search(contact):
    """点会话列表顶部的搜索框来搜索并打开联系人。
    注意**不要用 ⌘F**——它会不稳定地打开「搜一搜」全屏页而不是聊天搜索浮层。"""
    click(*search_box_point())
    time.sleep(0.5)
    key(K_A, cmd=True)
    time.sleep(0.1)
    paste_text(contact)
    time.sleep(1.6)
    ov = find_overlay()
    if not ov:
        key(K_ESC)
        return False
    img, b = capture_wid(int(ov["kCGWindowNumber"]))
    if img is None:
        key(K_ESC)
        return False
    items = ocr(img, b[0], b[1], b[2])
    # 浮层结构：搜索网络结果（网页建议）→ 「功能」（联系人/公众号）→ 「聊天记录」
    # 网页建议里也会有同名文字，必须跳过「功能」标题以上的命中，否则会点成网页搜索。
    func_y = next((r[2] for r in items if r[0].strip() == "功能"), None)
    matches = [r for r in items if contact in r[0] or r[0] in contact]
    if func_y is not None:
        below = [r for r in matches if r[2] > func_y]
        if below:
            matches = below
    if not matches:
        key(K_ESC)
        return False
    matches.sort(key=lambda r: r[2])  # 「功能」区里最上面那条 = 联系人
    r = matches[0]
    click(r[1] + r[3] / 2, r[2] + r[4] / 2)
    time.sleep(1.2)
    return True


def open_chat(contact, retries=2):
    """打开会话并校验标题：优先点可见会话行，找不到则走搜索浮层。"""
    for _ in range(retries + 1):
        activate()
        key(K_ESC)
        time.sleep(0.2)
        key(K_1, cmd=True)  # 切到「聊天」视图
        time.sleep(0.4)
        pos = find_session_row(contact)
        if pos:
            click(*pos)
            time.sleep(1.0)
        else:
            open_chat_by_search(contact)
        if _title_ok(contact, chat_title()):
            return True
    return False


def focus_input():
    """点击消息输入框把键盘焦点放进去（否则 ⌘V 会落空），并清掉可能的草稿。"""
    click(*input_box_point())
    time.sleep(0.25)
    key(K_A, cmd=True)
    time.sleep(0.1)


def input_text():
    """读输入框里当前的文字（用于确认粘贴是否真的落到输入框）。"""
    img, win = capture()
    ox, oy, ww, wh = win
    left = content_left(win)
    top = input_top(win)
    return " ".join(r[0] for r in ocr(img) if r[1] > left and r[2] > top)


def send_message(contact, message, retries=2):
    """发送文本：打开会话 → 点输入框 → 粘贴 → **确认文字进了输入框** → 回车。
    粘贴落空时自动重试，避免"假成功"。"""
    if not open_chat(contact):
        return False
    probe = message[:8]
    for _ in range(retries + 1):
        focus_input()
        paste_text(message)
        time.sleep(0.35)
        if probe in input_text():
            key(K_ENTER)
            time.sleep(0.45)
            return True
    return False


def send_file(contact, path):
    open_chat(contact)
    set_clipboard(path)
    time.sleep(0.1)
    # 微信支持 ⌘V 粘贴文件路径发送
    key(K_V, cmd=True)
    time.sleep(1.2)
    key(K_ENTER)
    time.sleep(0.5)


def content_left(win):
    """内容区左边界（会话列表右边界）。"""
    x, y, ww, wh = win
    return x + 262


def input_top(win):
    """输入框上沿 y（聊天区下边界）。输入区高约 273pt，取 275 留余量。"""
    x, y, ww, wh = win
    return y + wh - 275


def input_box_point(win=None):
    """消息输入框内部一点（用于点击把焦点放进去）。"""
    if win is None:
        win = capture()[1]
    x, y, ww, wh = win
    left = content_left(win)
    return (left + 180, y + wh * 0.66)


# ---------------- 颜色（判断消息方向） ----------------
GREEN = (149 / 255, 236 / 255, 105 / 255)  # 微信绿 #95EC69


def _make_rep(img):
    from AppKit import NSBitmapImageRep

    return NSBitmapImageRep.alloc().initWithCGImage_(img)


def _pix(rep, img, win, x_pt, y_pt):
    ox, oy, ww, wh = win
    scale = Quartz.CGImageGetWidth(img) / ww
    px = int((x_pt - ox) * scale)
    py = int((y_pt - oy) * scale)
    if px < 0 or py < 0:
        return None
    c = rep.colorAtX_y_(px, py)
    if c is None:
        return None
    return (c.redComponent(), c.greenComponent(), c.blueComponent())


def _is_green(c):
    if not c:
        return False
    r, g, b = c
    return g > 0.72 and (g - r) > 0.12 and (g - b) > 0.18


def _is_outgoing(rep, img, win, x, y, w, h):
    """靠气泡底色判断：采样文字右侧/左侧内边距，绿=我方。"""
    ymid = y + h / 2
    for probe in (x + w + 4, x - 5, x + w + 8):
        if _is_green(_pix(rep, img, win, probe, ymid)):
            return True
    return False


def read_chat(contact, n=12, do_open=True, convert_voice=False):
    """读取最近 n 条消息，返回 [{'dir','text'}]，dir 为 out/in。
    convert_voice=True 时先尝试把可见语音转成文字。"""
    if do_open and not open_chat(contact):
        return []
    if convert_voice:
        convert_voices()
    img, win = capture()
    save_png(img, f"{STATE_DIR}/_read.png")
    ox, oy, ww, wh = win
    left = content_left(win)
    bottom = input_top(win)
    rep = _make_rep(img)
    items = [r for r in ocr(img) if r[1] > left and oy + 105 < r[2] < bottom]
    items.sort(key=lambda r: r[2])
    msgs = []
    for text, x, y, w, h in items:
        if _is_time(text):
            continue
        d = "out" if _is_outgoing(rep, img, win, x, y, w, h) else "in"
        msgs.append({"dir": d, "text": text, "y": y})
    return msgs[-n:]


# ---------------- 语音转文字 ----------------
def find_voice_bubbles(img=None, win=None):
    """找出内容区里可见的语音气泡，返回 [(text,x,y,w,h)]。"""
    if img is None:
        img, win = capture()
    ox, oy, ww, wh = win
    left = content_left(win)
    bot = input_top(win)
    return [
        r for r in ocr(img) if r[1] > left and oy + 100 < r[2] < bot and _is_voice(r[0])
    ]


def convert_voices(max_n=10):
    """把可见语音逐条「转文字」。「转文字」需悬停才出现，故先移动鼠标到气泡上。
    返回转换条数。"""
    done = 0
    for _ in range(max_n):
        img, win = capture()
        bubbles = find_voice_bubbles(img, win)
        if not bubbles:
            break
        clicked = False
        for t, x, y, w, h in bubbles:
            move(x + w / 2, y + h / 2)  # 悬停触发「转文字」
            time.sleep(0.8)
            img2, _ = capture()
            btn = [r for r in ocr(img2) if "转文字" in r[0]]
            if btn:
                b = btn[0]
                click(b[1] + b[3] / 2, b[2] + b[4] / 2)
                time.sleep(1.8)
                done += 1
                clicked = True
                break
        if not clicked:
            break
    return done


def session_rows():
    """OCR 会话列表区所有文本行，返回 [(text, x, y, w, h)]。"""
    img, win = capture()
    ox, oy, ww, wh = win
    left = content_left(win)
    rows = [
        r
        for r in ocr(img)
        if r[1] < left and r[1] > ox + 90 and r[2] > oy + 60 and r[0].strip() != "搜索"
    ]
    rows.sort(key=lambda r: r[2])
    return rows


def list_sessions():
    """返回 [{'text','x','y'}]（原始行，供 CLI/调试）。"""
    return [{"text": t, "x": x, "y": y} for t, x, y, w, h in session_rows()]


def session_map():
    """把会话列表聚合成 [{'name','preview','y'}]（同一会话的多行按 y 聚类）。"""
    rows = session_rows()
    groups, cur = [], []
    for r in rows:
        if cur and r[2] - cur[-1][2] > 30:
            groups.append(cur)
            cur = []
        cur.append(r)
    if cur:
        groups.append(cur)
    return [
        {"name": g[0][0], "preview": " ".join(x[0] for x in g[1:]), "y": g[0][2]}
        for g in groups
    ]


def session_preview(contact):
    """返回某联系人在会话列表里的预览文本（用于检测是否有新回复）；找不到返回 None。"""
    for s in session_map():
        if contact in s["name"] or s["name"] in contact:
            return s["preview"]
    return None


# ---------------- CLI ----------------
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    try:
        _dispatch(cmd)
    except WindowTooSmall as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(2)
    except RuntimeError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(1)


def _dispatch(cmd):
    # ---- 只读 JSON 接口（供 Gravitas 主进程消费，不提供 send）----
    if cmd == "sessions-json":
        # 只读：仅截图 + OCR，不点击、不发消息
        print(json.dumps(session_map(), ensure_ascii=False))
        return
    if cmd == "read-json":
        # 只读：open_chat 会点击会话行，但不输入、不发送
        contact = sys.argv[2]
        n = int(sys.argv[3]) if len(sys.argv) > 3 else 12
        msgs = read_chat(contact, n)
        print(json.dumps({"contact": contact, "messages": msgs}, ensure_ascii=False))
        return
    if cmd == "probe":
        _w, b = require_usable_window()
        print("window:", b)
        img, _ = capture()
        p = f"{STATE_DIR}/wechat_window.png"
        save_png(img, p)
        print("saved:", p)
    elif cmd == "ocr":
        img, _ = capture()
        save_png(img, f"{STATE_DIR}/wechat_window.png")
        for r in sorted(ocr(img), key=lambda t: t[2]):
            print(f"[{r[1]:6.1f},{r[2]:6.1f}] {r[0]}")
    elif cmd == "sessions":
        for s in list_sessions():
            print(f"y={s['y']:6.1f} x={s['x']:6.1f}  {s['text']}")
    elif cmd == "read":
        contact = sys.argv[2]
        n = int(sys.argv[3]) if len(sys.argv) > 3 else 12
        cv = "--voice" in sys.argv
        for m in read_chat(contact, n, convert_voice=cv):
            print(f"{'→' if m['dir'] == 'out' else '←'} {m['text']}")
    elif cmd == "bubbles":
        for t, x, y, w, h in find_voice_bubbles():
            print(f"   语音 {t!r} at ({x:.0f},{y:.0f})")
    elif cmd == "voices":
        print("已转换语音条数:", convert_voices())
    elif cmd == "send":
        ok = send_message(sys.argv[2], sys.argv[3])
        print("sent ->" + sys.argv[2] if ok else "FAILED ->" + sys.argv[2])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
