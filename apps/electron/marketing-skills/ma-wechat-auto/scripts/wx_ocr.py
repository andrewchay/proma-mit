#!/usr/bin/env python3
"""截图微信窗口并用 Vision OCR 输出文字 + 屏幕坐标（点），用于校准点击位置。

用法: python3 wx_ocr.py
依赖: pyobjc-framework-Quartz, pyobjc-framework-Vision
"""
import os
import sys

import Quartz
import Vision
from Foundation import NSURL

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

PNG_OUT = paths.WINDOW_PNG


def find_main_window():
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly
        | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    cands = []
    for w in wins:
        owner = str(w.get("kCGWindowOwnerName", ""))
        if ("微信" in owner or "WeChat" in owner) and w.get("kCGWindowLayer") == 0:
            cands.append(w)
    if not cands:
        return None
    cands.sort(
        key=lambda w: w["kCGWindowBounds"]["Width"] * w["kCGWindowBounds"]["Height"],
        reverse=True,
    )
    return cands[0]


def save_png(img, path):
    url = NSURL.fileURLWithPath_(path)
    dest = Quartz.CGImageDestinationCreateWithURL(url, "public.png", 1, None)
    Quartz.CGImageDestinationAddImage(dest, img, None)
    Quartz.CGImageDestinationFinalize(dest)


def ocr(cgimg):
    results = []

    def handler(request, error):
        if error:
            print("OCR error:", error)
            return
        for obs in request.results():
            top = obs.topCandidates_(1)
            if not top:
                continue
            text = top[0].string()
            bb = obs.boundingBox()
            results.append((text, top[0].confidence(), bb))

    req = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(["zh-Hans", "en-US"])
    req.setUsesLanguageCorrection_(True)
    h = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cgimg, None)
    h.performRequests_error_([req], None)
    return results


def main():
    paths.ensure_state()
    w = find_main_window()
    if not w:
        print("!! 未找到微信主窗口")
        return
    b = dict(w["kCGWindowBounds"])
    win_x, win_y = b["X"], b["Y"]
    win_w, win_h = b["Width"], b["Height"]
    wid = int(w["kCGWindowNumber"])
    img = Quartz.CGWindowListCreateImage(
        Quartz.CGRectNull,
        Quartz.kCGWindowListOptionIncludingWindow,
        wid,
        Quartz.kCGWindowImageBoundsIgnoreFraming,
    )
    if img is None:
        print("!! 截图失败：缺少屏幕录制权限")
        return
    save_png(img, PNG_OUT)
    iw = Quartz.CGImageGetWidth(img)
    ih = Quartz.CGImageGetHeight(img)
    scale = iw / win_w
    print(f"窗口: pos=({win_x},{win_y}) size={win_w}x{win_h}")
    print(f"截图: {iw}x{ih}px  缩放={scale:.2f}  (Retina 应为 2.00)")
    print(f"已存: {PNG_OUT}")
    print("-" * 60)
    res = ocr(img)
    res.sort(key=lambda r: (round(r[2].origin.y, 3), r[2].origin.x))
    for text, conf, bb in res:
        # Vision 归一化坐标(左下原点) → 图片像素(左上原点) → 屏幕点
        px = bb.origin.x * iw
        py = (1 - bb.origin.y - bb.size.height) * ih
        pw = bb.size.width * iw
        ph = bb.size.height * ih
        sx = win_x + px / scale
        sy = win_y + py / scale
        print(
            f"[{sx:6.1f},{sy:6.1f}] {pw/scale:5.1f}x{ph/scale:4.1f}  {text}"
        )


if __name__ == "__main__":
    main()
