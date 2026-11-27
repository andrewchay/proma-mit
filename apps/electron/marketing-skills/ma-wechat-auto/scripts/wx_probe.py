#!/usr/bin/env python3
"""探测微信窗口位置并截图，用于校准自动化脚本的坐标。

用法: python3 wx_probe.py [输出png路径]
依赖: pyobjc-framework-Quartz
"""
import os
import sys
import Quartz
from Foundation import NSURL

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

DEFAULT_OUT = paths.WINDOW_PNG


def list_wechat_windows():
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly
        | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    out = []
    for w in wins:
        owner = str(w.get("kCGWindowOwnerName", ""))
        if "WeChat" in owner or "微信" in owner:
            out.append(
                {
                    "owner": owner,
                    "name": w.get("kCGWindowName", ""),
                    "id": int(w.get("kCGWindowNumber", 0)),
                    "bounds": dict(w.get("kCGWindowBounds", {})),
                    "layer": w.get("kCGWindowLayer", 0),
                    "alpha": w.get("kCGWindowAlpha", 1),
                }
            )
    return out


def capture(wid, out):
    img = Quartz.CGWindowListCreateImage(
        Quartz.CGRectNull,
        Quartz.kCGWindowListOptionIncludingWindow,
        wid,
        Quartz.kCGWindowImageBoundsIgnoreFraming,
    )
    if img is None:
        print("!! 截图失败：很可能是缺少『屏幕录制』权限")
        return False
    url = NSURL.fileURLWithPath_(out)
    dest = Quartz.CGImageDestinationCreateWithURL(url, "public.png", 1, None)
    if dest is None:
        print("!! 无法创建图片目标")
        return False
    Quartz.CGImageDestinationAddImage(dest, img, None)
    ok = Quartz.CGImageDestinationFinalize(dest)
    print(("已保存: " if ok else "保存失败: ") + out)
    return ok


def main():
    paths.ensure_state()
    out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    wins = list_wechat_windows()
    print(f"找到 {len(wins)} 个微信相关窗口:")
    for w in wins:
        b = w["bounds"]
        print(
            f"  id={w['id']} layer={w['layer']} alpha={w['alpha']} "
            f"pos=({b.get('X')},{b.get('Y')}) size={b.get('Width')}x{b.get('Height')} "
            f"title={w['name']!r} owner={w['owner']}"
        )
    cand = [w for w in wins if w["layer"] == 0] or wins
    if not cand:
        print("!! 没有可截图的微信窗口（微信主窗口可能被关闭了）")
        return
    cand.sort(
        key=lambda w: w["bounds"].get("Width", 0) * w["bounds"].get("Height", 0),
        reverse=True,
    )
    t = cand[0]
    print(f"→ 目标窗口 id={t['id']} bounds={t['bounds']}")
    capture(t["id"], out)


if __name__ == "__main__":
    main()
