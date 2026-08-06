#!/usr/bin/env python3
"""Gravitas 图标系列生成器。

同一套几何参数，同时输出：
1. 每个变体的 SVG 文件（矢量主文件，可无限缩放）
2. 每个变体的 1024px PNG（供预览与后续 generate:icons 使用）

标志结构（定稿 A）：
- 粗体几何 G（圆环弧 + 短横笔）
- 带倾角轨道环的星球，位于 G 右侧开口正中
- 短横笔末端与星球轨道环衔接
"""

import math
import os
from PIL import Image, ImageDraw

# ---------------------------------------------------------------- 几何参数
# 以 1024 viewBox 为基准，PNG 渲染时按比例放大
VB = 1024.0
CX = CY = VB / 2

ARC_RADIUS = VB * 0.270          # G 圆弧中心线半径
ARC_WIDTH = VB * 0.105           # G 笔画宽度
ARC_GAP_DEG = 52.0               # 开口半角（开口总角 104°）

PLANET_X = CX + ARC_RADIUS * 0.78   # 星球中心 x（开口正中）
PLANET_R = ARC_WIDTH * 0.50         # 星球半径
RING_RX = PLANET_R * 2.6            # 轨道环长轴
RING_RY = PLANET_R * 0.68           # 轨道环短轴
RING_WIDTH = ARC_WIDTH * 0.17       # 轨道环线宽
RING_TILT_DEG = 16.0                # 轨道环倾角（逆时针，右端上扬）

BAR_WIDTH = ARC_WIDTH * 0.50        # 短横笔厚度
BAR_X0 = CX - ARC_RADIUS * 0.05     # 短横笔起点
BAR_X1 = PLANET_X - RING_RX * 0.98  # 短横笔终点（恰好切在轨道环左缘）

TILE_RADIUS_RATIO = 0.225           # 圆角矩形半径比例（接近 macOS 规范）


# ---------------------------------------------------------------- SVG 生成
def arc_endpoints():
    """计算 G 圆弧两端点（SVG 坐标系，y 向下）。"""
    x = CX + ARC_RADIUS * math.cos(math.radians(ARC_GAP_DEG))
    y_top = CY - ARC_RADIUS * math.sin(math.radians(ARC_GAP_DEG))
    y_bot = CY + ARC_RADIUS * math.sin(math.radians(ARC_GAP_DEG))
    return x, y_top, y_bot


def render_svg(bg: str, mark: str, defs: str = "") -> str:
    ax, ay_top, ay_bot = arc_endpoints()
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
{defs}  <rect width="1024" height="1024" rx="{int(VB * TILE_RADIUS_RATIO)}" fill="{bg}"/>
  <g fill="none" stroke="{mark}">
    <path d="M {ax:.1f} {ay_bot:.1f} A {ARC_RADIUS:.1f} {ARC_RADIUS:.1f} 0 1 1 {ax:.1f} {ay_top:.1f}" stroke-width="{ARC_WIDTH:.1f}"/>
    <ellipse cx="{PLANET_X:.1f}" cy="{CY:.1f}" rx="{RING_RX:.1f}" ry="{RING_RY:.1f}" stroke-width="{RING_WIDTH:.1f}" transform="rotate({RING_TILT_DEG:.1f} {PLANET_X:.1f} {CY:.1f})"/>
  </g>
  <rect x="{BAR_X0:.1f}" y="{CY - BAR_WIDTH / 2:.1f}" width="{BAR_X1 - BAR_X0:.1f}" height="{BAR_WIDTH:.1f}" fill="{mark}"/>
  <circle cx="{PLANET_X:.1f}" cy="{CY:.1f}" r="{PLANET_R:.1f}" fill="{mark}"/>
</svg>
'''


# ---------------------------------------------------------------- PNG 生成
def hex_rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def draw_mark(size: int, bg: str, mark: str, out: str,
              mark_gradient: tuple | None = None):
    """超采样绘制后降采样，保证曲线平滑。"""
    SS = 4
    S = size * SS
    k = S / VB  # 缩放系数

    img = Image.new("RGB", (S, S), hex_rgb(bg))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1],
                        radius=S * TILE_RADIUS_RATIO, fill=hex_rgb(bg))

    # 标记统一先画到 mask 上（支持纯色与渐变两种填充）
    mask = Image.new("L", (S, S), 0)
    m = ImageDraw.Draw(mask)

    cx = cy = S / 2
    R = ARC_RADIUS * k
    W = int(ARC_WIDTH * k)

    # G 圆弧（PIL 角度从 3 点方向起顺时针；开口 ±52° → 52° 到 308°）
    m.arc([cx - R, cy - R, cx + R, cy + R],
          start=ARC_GAP_DEG, end=360 - ARC_GAP_DEG, fill=255, width=W)

    px = PLANET_X * k
    pr = PLANET_R * k

    # 轨道环：单独图层画椭圆再旋转，实现倾角
    ring_layer = Image.new("L", (S, S), 0)
    rd = ImageDraw.Draw(ring_layer)
    rx, ry = RING_RX * k, RING_RY * k
    rd.ellipse([px - rx, cy - ry, px + rx, cy + ry],
               outline=255, width=int(RING_WIDTH * k))
    ring_layer = ring_layer.rotate(RING_TILT_DEG, center=(px, cy),
                                   resample=Image.BICUBIC)
    mask.paste(255, (0, 0), ring_layer)

    # 短横笔
    bar_w = BAR_WIDTH * k
    m.rectangle([BAR_X0 * k, cy - bar_w / 2, BAR_X1 * k, cy + bar_w / 2],
                fill=255)

    # 星球本体（盖在环之上，形成前后遮挡）
    m.ellipse([px - pr, cy - pr, px + pr, cy + pr], fill=255)

    # 填充标记颜色
    if mark_gradient:
        import numpy as np
        c0, c1 = hex_rgb(mark_gradient[0]), hex_rgb(mark_gradient[1])
        t = np.linspace(0, 1, S, dtype=np.float32)
        grad = np.zeros((S, S, 3), dtype=np.uint8)
        for ch in range(3):
            col = (c0[ch] + (c1[ch] - c0[ch]) * t).astype(np.uint8)
            grad[:, :, ch] = col[None, :]  # 水平方向渐变
        mark_img = Image.fromarray(grad, "RGB")
    else:
        mark_img = Image.new("RGB", (S, S), hex_rgb(mark))
    img.paste(mark_img, (0, 0), mask)

    img = img.resize((size, size), Image.LANCZOS)
    img.save(out)


# ---------------------------------------------------------------- 变体清单
VARIANTS = [
    # (文件名, 名称, 底色, 标记色, 标记渐变)
    ("01-default",    "默认（深炭底白标）", "#141416", "#FFFFFF", None),
    ("02-black",      "经典黑",            "#000000", "#FFFFFF", None),
    ("03-white",      "纯白",              "#FAFAF7", "#1A1A1E", None),
    ("04-coral",      "珊瑚橘",            "#FF6B4A", "#FFFFFF", None),
    ("05-brand-blue", "品牌蓝",            "#2B5CE6", "#FFFFFF", None),
    ("06-periwinkle", "长春花蓝",          "#8B93E8", "#FFFFFF", None),
    ("07-viva-magenta", "非凡洋红",        "#BB2649", "#FFFFFF", None),
    ("08-mocha",      "摩卡慕斯",          "#A47864", "#FFFFFF", None),
    ("09-emerald",    "翡翠绿",            "#1F8A70", "#FFFFFF", None),
    ("10-gradient",   "渐变版",            "#141428", None, ("#FF6B4A", "#7A5CFF")),
]

BASE = os.path.dirname(os.path.abspath(__file__))
SVG_DIR = os.path.normpath(os.path.join(BASE, "../svg"))
PNG_DIR = os.path.normpath(os.path.join(BASE, "../series-final"))
os.makedirs(SVG_DIR, exist_ok=True)
os.makedirs(PNG_DIR, exist_ok=True)

GRADIENT_DEFS = '''  <defs>
    <linearGradient id="gm" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#FF6B4A"/>
      <stop offset="1" stop-color="#7A5CFF"/>
    </linearGradient>
  </defs>
'''

for slug, name, bg, mark, grad in VARIANTS:
    svg_path = os.path.join(SVG_DIR, f"gravitas-{slug}.svg")
    png_path = os.path.join(PNG_DIR, f"gravitas-{slug}.png")

    if grad:
        svg = render_svg(bg, "url(#gm)", defs=GRADIENT_DEFS)
        draw_mark(1024, bg, "#FFFFFF", png_path, mark_gradient=grad)
    else:
        svg = render_svg(bg, mark)
        draw_mark(1024, bg, mark, png_path)

    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(svg)
    print(f"✓ {name}: {svg_path} / {png_path}")

print("\n全部变体生成完成。")
