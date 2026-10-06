"""生成主题预览的绘画质感静态素材（仅开发期使用，需 Pillow）。

运行：python3 scripts/generate-theme-preview-art.py
所有作品共用竖幅画布、柔边笔触、纸张颗粒和有限配色；不用于界面背景。
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "apps/electron/src/renderer/assets/theme-previews"
W, H = 400, 600


def rgb(color: str) -> tuple[int, int, int]:
    return tuple(bytes.fromhex(color.lstrip("#")))  # type: ignore[return-value]


def blend(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(x * (1 - t) + y * t) for x, y in zip(a, b))


class Canvas:
    def __init__(self, seed: int, top: str, bottom: str):
        self.rng = random.Random(seed)
        a, b = rgb(top), rgb(bottom)
        self.image = Image.new("RGB", (W, H))
        draw = ImageDraw.Draw(self.image)
        for y in range(H):
            draw.line((0, y, W, y), fill=blend(a, b, y / H))
        self.haze = Image.new("RGBA", (W, H))
        self.paint = Image.new("RGBA", (W, H))

    def glow(self, x: float, y: float, radius: float, color: str, alpha: int = 90):
        layer = Image.new("RGBA", (W, H))
        d = ImageDraw.Draw(layer)
        r = int(radius)
        d.ellipse((x - r, y - r, x + r, y + r), fill=(*rgb(color), alpha))
        self.haze = Image.alpha_composite(self.haze, layer.filter(ImageFilter.GaussianBlur(max(5, r // 2))))

    def ellipse(self, box, color: str, alpha: int = 255):
        ImageDraw.Draw(self.paint, "RGBA").ellipse(box, fill=(*rgb(color), alpha))

    def polygon(self, points, color: str, alpha: int = 255):
        ImageDraw.Draw(self.paint, "RGBA").polygon(points, fill=(*rgb(color), alpha))

    def stroke(self, points, color: str, width: int = 4, alpha: int = 255):
        ImageDraw.Draw(self.paint, "RGBA").line(points, fill=(*rgb(color), alpha), width=width, joint="curve")

    def brush(self, x: float, y: float, length: float, angle: float, color: str, width: float = 9, alpha: int = 90):
        """随机轻微摆动的短笔触，模拟颜料叠色而非纯几何描边。"""
        dx, dy = math.cos(angle) * length / 2, math.sin(angle) * length / 2
        self.stroke([(x - dx, y - dy), (x + dx, y + dy)], color, max(1, int(width)), alpha)

    def curved(self, points, color: str, width: int = 5, alpha: int = 255):
        """用 Catmull-Rom 插值将控制点变成平滑笔触。"""
        if len(points) < 2:
            return
        padded = [points[0], *points, points[-1]]
        result = []
        for i in range(1, len(padded) - 2):
            p0, p1, p2, p3 = padded[i - 1:i + 3]
            for j in range(12):
                t = j / 12
                result.append(tuple(round(.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t +
                    (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t +
                    (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t ** 3)) for k in (0, 1)))
        result.append(points[-1])
        self.stroke(result, color, width, alpha)

    def finish(self, name: str):
        base = Image.alpha_composite(self.image.convert("RGBA"), self.haze)
        base = Image.alpha_composite(base, self.paint)
        # 细微纸张纹理覆盖在所有图层上，使构图属于同一系列。
        grain = Image.new("RGBA", (W, H))
        pix = grain.load()
        for y in range(H):
            for x in range(W):
                n = self.rng.randint(0, 255)
                pix[x, y] = (245, 233, 212, 10) if n > 160 else (25, 25, 30, 8)
        base = Image.alpha_composite(base, grain).convert("RGB")
        base.save(OUTPUT / f"theme-{name}.webp", format="WEBP", quality=88, method=6)


def background_strokes(c: Canvas, colors: tuple[str, ...], count: int = 460):
    r = c.rng
    for _ in range(count):
        c.brush(r.randint(-20, W + 20), r.randint(0, H), r.randint(6, 46),
                r.uniform(-.8, .8), r.choice(colors), r.randint(4, 22), r.randint(12, 50))


def leaf(c: Canvas, x: float, y: float, rx: float, ry: float, tilt: float, color: str):
    """锥形叶片由多层半透明笔触塑形。"""
    r = c.rng
    tip = (x + math.sin(tilt) * ry, y - math.cos(tilt) * ry)
    base = (x - math.sin(tilt) * ry, y + math.cos(tilt) * ry)
    side = (math.cos(tilt) * rx, math.sin(tilt) * rx)
    c.polygon([base, (x + side[0], y + side[1]), tip, (x - side[0], y - side[1])], color, 175)
    for _ in range(22):
        t = r.random()
        px = base[0] * (1 - t) + tip[0] * t + r.uniform(-rx / 2, rx / 2)
        py = base[1] * (1 - t) + tip[1] * t + r.uniform(-rx / 2, rx / 2)
        c.brush(px, py, r.uniform(5, 16), tilt - math.pi / 2,
                r.choice((color, "#F4EFE5", "#59796C")), 2, r.randint(25, 85))


def herbs(c: Canvas, purple: bool = False):
    r = c.rng
    stem = "#7C8296" if purple else "#607D72"
    flowers = ("#B9AFD8", "#8F80B4", "#D7D1DC", "#776799") if purple else (
        "#89A8A0", "#617E73", "#A5B8A0", "#D7C5A1")
    for j in range(13):
        x = j * 34 - 28 + r.randint(-12, 12)
        top = r.randint(146, 340)
        shift = r.randint(-30, 30)
        c.curved([(x, 615), (x + shift / 2, 420), (x + shift, top)], stem, r.randint(2, 5), 170)
        for side in (-1, 1):
            ly = r.randint(380, 490)
            leaf(c, x + side * 20, ly, 11, 34, side * .8, stem)
        cx = x + shift
        for k in range(35):
            t = r.random()
            fx = cx + r.gauss(0, 11 * (1 - t) + 3)
            fy = top + t * 96
            color = r.choice(flowers)
            c.ellipse((fx - 2, fy - 4, fx + 4, fy + 5), color, r.randint(115, 230))
            if k % 4 == 0:
                c.brush(fx, fy, r.randint(3, 10), r.uniform(-1, 1), "#F4EFEA", 2, 70)


def sage():
    c = Canvas(41, "#F1EFE7", "#D7C5A1")
    background_strokes(c, ("#F1EFE7", "#D7C5A1", "#89A8A0"), 700)
    c.glow(245, 158, 130, "#FBF7EA", 130)
    herbs(c)
    c.finish("sage")


def lavender():
    c = Canvas(68, "#F2EEEA", "#D7D1DC")
    background_strokes(c, ("#F2EEEA", "#D7D1DC", "#B9AFD8"), 680)
    c.glow(235, 142, 128, "#F9F4ED", 115)
    herbs(c, purple=True)
    c.finish("lavender")


def peach():
    c = Canvas(93, "#F6E2DB", "#EAD8C4")
    background_strokes(c, ("#F6E2DB", "#EAD8C4", "#F0C4A8"), 720)
    c.glow(240, 155, 130, "#FAF0E3", 110)
    r = c.rng
    c.curved([(340, -20), (290, 92), (210, 194), (190, 270)], "#746853", 7, 150)
    for x, y, size in [(157, 264, 77), (283, 326, 92), (89, 455, 60)]:
        c.glow(x, y, size * .8, "#EAAE8C", 55)
        c.ellipse((x - size, y - size, x + size, y + size), "#D8947A", 185)
        c.ellipse((x - size + 8, y - size + 8, x + size - 8, y + size - 8), "#F0C4A8", 225)
        for _ in range(180):
            dx, dy = r.uniform(-1, 1), r.uniform(-1, 1)
            if dx * dx + dy * dy > .9:
                continue
            col = r.choice(("#F6D2B9", "#E7A88B", "#F2A995", "#FFD9C1"))
            c.brush(x + dx * size, y + dy * size, r.randint(5, 19), r.uniform(-.7, .7), col, r.randint(2, 8), r.randint(35, 140))
        c.curved([(x - 3, y - size + 4), (x + 5, y - size // 2), (x + 12, y + size // 3)], "#C98F7B", 3, 95)
        leaf(c, x + 40, y - size - 28, 18, 39, .95, "#8BA589")
    c.finish("peach")


def ember_light():
    c = Canvas(105, "#F5EFE9", "#E8D5C8")
    background_strokes(c, ("#F5EFE9", "#E8DDD4", "#D7BFA9"), 650)
    c.glow(287, 182, 142, "#F5C794", 130)
    c.ellipse((223, 111, 330, 218), "#EDC99D", 160)
    c.polygon([(0, 470), (145, 384), (264, 462), (400, 367), (400, 600), (0, 600)], "#B97553", 140)
    c.polygon([(0, 531), (136, 454), (274, 510), (400, 442), (400, 600), (0, 600)], "#AF5C2C", 180)
    # 陶罐与柔和侧光，呼应主题的陶土色而非 UI 截图。
    c.ellipse((106, 318, 293, 565), "#A45136", 210)
    c.ellipse((124, 334, 280, 552), "#C37B53", 220)
    c.ellipse((150, 310, 250, 350), "#DB9671", 235)
    c.ellipse((164, 316, 236, 337), "#533628", 190)
    r = c.rng
    for _ in range(290):
        x, y = r.randint(120, 278), r.randint(342, 542)
        if ((x - 200) / 82) ** 2 + ((y - 443) / 108) ** 2 > 1:
            continue
        c.brush(x, y, r.randint(4, 22), r.uniform(-.6, .7),
                r.choice(("#F0B388", "#994B31", "#D88C5C", "#EBC3A0")), 3, r.randint(20, 110))
    c.finish("ember-light-art")


def ember_dark():
    c = Canvas(108, "#1E1E20", "#353034")
    background_strokes(c, ("#343032", "#48352D", "#1E1E20"), 590)
    c.glow(240, 300, 175, "#D27640", 145)
    c.polygon([(0, 480), (400, 463), (400, 600), (0, 600)], "#211D1E", 245)
    # 炉光映照的陶罐静物。
    c.ellipse((108, 308, 303, 564), "#6B3F32", 240)
    c.ellipse((128, 325, 288, 550), "#945139", 215)
    c.ellipse((153, 302, 260, 344), "#BB6740", 220)
    c.ellipse((165, 311, 247, 333), "#281E1F", 220)
    r = c.rng
    for _ in range(320):
        x, y = r.randint(127, 287), r.randint(338, 545)
        if ((x - 207) / 80) ** 2 + ((y - 441) / 106) ** 2 > 1:
            continue
        c.brush(x, y, r.randint(4, 23), r.uniform(-.6, .7),
                r.choice(("#D27640", "#E99B62", "#6A3E34", "#B4603B")), 3, r.randint(20, 120))
    for _ in range(95):
        x, y = r.randint(20, 390), r.randint(72, 365)
        c.ellipse((x, y, x + r.randint(1, 3), y + r.randint(2, 5)), "#E3A474", r.randint(35, 155))
    c.finish("ember-dark-art")


def night_mountains():
    c = Canvas(116, "#0D131A", "#1B3638")
    background_strokes(c, ("#1A2D37", "#173C3E", "#2E5A55"), 390)
    c.glow(284, 128, 106, "#B3E9D4", 160)
    c.ellipse((243, 88, 326, 171), "#C6E9D4", 220)
    r = c.rng
    for layer, (col, ybase) in enumerate((("#668D84", 338), ("#326B65", 430), ("#1A4645", 502), ("#102C30", 585))):
        pts = [(0, H)]
        for x in range(-20, 440, 16):
            ridge = 72 * math.sin(x / (47 + layer * 9) + layer * 2) + 32 * math.sin(x / 18 + layer)
            pts.append((x, ybase - ridge + r.randint(-11, 11)))
        pts.extend([(W, H)])
        c.polygon(pts, col, 235)
        for _ in range(180):
            x = r.randint(0, W)
            y = r.randint(ybase - 55, min(H, ybase + 92))
            c.brush(x, y, r.randint(3, 14), r.uniform(-.3, .4), r.choice(("#6C9C90", "#B3B89A", "#277477")), 2, r.randint(20, 100))
    c.finish("landscape-night")


def vermeer():
    c = Canvas(133, "#16191C", "#22262D")
    background_strokes(c, ("#1E293B", "#252327", "#29384C"), 560)
    c.glow(98, 131, 160, "#E5C86B", 135)
    c.polygon([(5, 62), (161, 62), (161, 304), (5, 304)], "#D9BD70", 190)
    c.stroke([(82, 62), (82, 304)], "#594938", 10, 220)
    c.stroke([(5, 172), (161, 172)], "#594938", 10, 220)
    c.polygon([(20, 305), (164, 305), (395, 600), (75, 600)], "#C5A65F", 35)
    # 肖像以明暗交替的颜料块塑形，不使用扁平描边轮廓。
    c.ellipse((140, 282, 446, 680), "#1A2941", 245)
    c.ellipse((175, 142, 378, 362), "#1D345B", 235)
    c.ellipse((216, 223, 349, 390), "#B58D6D", 220)
    c.ellipse((213, 230, 300, 346), "#D5AB81", 160)
    c.polygon([(190, 197), (283, 147), (372, 241), (334, 301), (250, 251)], "#365078", 235)
    c.curved([(175, 212), (275, 153), (364, 239)], "#E5C86B", 11, 160)
    c.glow(337, 376, 34, "#FCF8E9", 140)
    c.ellipse((326, 363, 345, 388), "#F8F9FA", 245)
    c.brush(331, 370, 10, -.8, "#FFFFFF", 3, 230)
    c.finish("vermeer-night")


def caravaggio():
    c = Canvas(172, "#141012", "#211919")
    background_strokes(c, ("#3D2C25", "#392E29", "#0F0E11"), 450)
    c.polygon([(0, 0), (104, 0), (393, 548), (236, 530)], "#B48450", 58)
    c.glow(98, 114, 176, "#D9A45B", 100)
    c.polygon([(0, 462), (400, 440), (400, 600), (0, 600)], "#241C1A", 250)
    r = c.rng
    for x, y, radius, col in ((110, 417, 66, "#AE7B53"), (228, 425, 82, "#8E5B43"), (337, 437, 52, "#D9A45B")):
        c.ellipse((x - radius, y - radius, x + radius, y + radius), col, 215)
        c.glow(x - radius // 3, y - radius // 2, radius * .7, "#D9A45B", 85)
        for _ in range(110):
            u, v = r.uniform(-1, 1), r.uniform(-1, 1)
            if u*u + v*v > .85:
                continue
            c.brush(x + u*radius, y + v*radius, r.randint(4, 16), r.uniform(-.6, .6),
                    r.choice(("#D9A45B", "#8B5E48", "#E2BB79", "#4B3430")), 3, r.randint(30, 100))
    c.polygon([(192, 205), (253, 197), (293, 455), (160, 461)], "#806456", 210)
    c.ellipse((189, 188, 261, 219), "#B68D6A", 220)
    c.finish("caravaggio-night")


def vangogh():
    c = Canvas(188, "#111A36", "#253A67")
    background_strokes(c, ("#3A5684", "#5276A0", "#2E4672"), 840)
    r = c.rng
    for cx, cy, radius in ((255, 187, 104), (78, 310, 59)):
        for i in range(19):
            angle = i * 2.2
            points = []
            for j in range(46):
                t = j / 45
                a = angle + t * 2.4
                rad = radius * (.27 + .75 * t) + i * 1.4
                points.append((int(cx + math.cos(a)*rad), int(cy + math.sin(a)*rad*.63)))
            c.stroke(points, r.choice(("#E7C456", "#A9BCD4", "#607DB0")), r.randint(3, 9), r.randint(95, 205))
    for x, y, size in ((325, 81, 30), (42, 100, 13), (178, 90, 12), (348, 264, 14)):
        c.glow(x, y, size * 2.1, "#F8D66B", 120)
        c.ellipse((x-size, y-size, x+size, y+size), "#E7C456", 220)
        for i in range(14):
            a = i * math.tau/14
            c.brush(x + math.cos(a)*size*1.6, y + math.sin(a)*size*1.6, size*.48, a, "#F5D977", 3, 110)
    c.polygon([(0, 509), (116, 462), (235, 505), (400, 456), (400, 600), (0, 600)], "#1A2B49", 245)
    for x in (47, 110, 180, 278, 351):
        c.polygon([(x - 12, 563), (x - 12, 503), (x, 477), (x + 13, 507), (x + 13, 563)], "#192540", 225)
    c.polygon([(80, 600), (93, 432), (72, 405), (99, 337), (90, 305), (122, 358), (111, 412), (140, 600)], "#0B1729", 245)
    c.finish("vangogh-night")


def synthwave():
    c = Canvas(211, "#121028", "#261643")
    background_strokes(c, ("#482851", "#392251", "#1E244B"), 540)
    c.glow(208, 276, 155, "#F27BC5", 140)
    c.ellipse((99, 152, 305, 358), "#E68CBD", 205)
    for y in range(238, 361, 14):
        c.stroke([(88, y), (322, y)], "#1C173B", max(3, (y - 225)//5), 220)
    c.polygon([(0, 398), (107, 296), (171, 397)], "#241B3B", 240)
    c.polygon([(229, 399), (353, 275), (400, 340), (400, 399)], "#2C2046", 240)
    c.stroke([(0, 400), (400, 400)], "#E98CCB", 6, 220)
    for x in range(-300, 750, 68):
        c.stroke([(200, 404), (x, 600)], "#A065BC", 3, 135)
    for y in (427, 455, 497, 554):
        c.stroke([(0, y), (400, y)], "#A065BC", 3, 120)
    c.finish("synthwave-night")


if __name__ == "__main__":
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for generate in (sage, peach, lavender, ember_light, ember_dark, night_mountains, vermeer, caravaggio, vangogh, synthwave):
        generate()
