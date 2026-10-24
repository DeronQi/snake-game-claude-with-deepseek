"""生成 PWA 图标（192/512 普通图标 + 192/512 maskable 图标）。

仅使用 Pillow；重复执行会覆盖为完全相同的文件。
运行：python tools/make_icons.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
SCALE = 4

BG_TOP = (10, 31, 46)
BG_BOTTOM = (3, 8, 15)
GRID = (116, 217, 166, 22)
GREEN_DARK = (19, 100, 62)
GREEN_MID = (43, 205, 118)
GREEN_LIGHT = (130, 255, 176)
ORANGE = (255, 112, 72)
ORANGE_LIGHT = (255, 205, 166)


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def mix(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t))


def make_background(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), BG_BOTTOM + (255,))
    draw = ImageDraw.Draw(image)

    for y in range(size):
        t = y / max(1, size - 1)
        color = mix(BG_TOP, BG_BOTTOM, t ** 0.78)
        draw.line([(0, y), (size, y)], fill=color + (255,))

    # 绿色氛围光
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    radius = int(size * 0.66)
    cx, cy = int(size * 0.23), int(size * 0.16)
    for i in range(radius, 0, -4):
        t = 1 - i / radius
        alpha = int(30 * (t ** 2.2))
        glow_draw.ellipse(
            [cx - i, cy - i, cx + i, cy + i],
            fill=(50, 235, 137, alpha),
        )
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.06))
    image = Image.alpha_composite(image, glow)

    # 细网格
    grid = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    step = size / 10
    width = max(1, round(size / 384))
    for i in range(1, 10):
        p = round(i * step)
        gd.line([(p, 0), (p, size)], fill=GRID, width=width)
        gd.line([(0, p), (size, p)], fill=GRID, width=width)
    image = Image.alpha_composite(image, grid)

    # 内置描边
    inset = max(2, round(size * 0.018))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        [inset, inset, size - inset - 1, size - inset - 1],
        radius=round(size * 0.18),
        outline=(126, 238, 178, 42),
        width=max(1, round(size / 300)),
    )
    return image


def draw_snake_and_fruit(image: Image.Image, maskable: bool) -> Image.Image:
    size = image.size[0]
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    scale = 0.72 if maskable else 0.9
    offset = (1 - scale) / 2

    def point(nx: float, ny: float) -> tuple[int, int]:
        return (round((offset + nx * scale) * size), round((offset + ny * scale) * size))

    # 尾巴 → 头部，越靠头越亮、越粗
    points = [
        (0.23, 0.76),
        (0.27, 0.65),
        (0.38, 0.60),
        (0.51, 0.62),
        (0.63, 0.57),
        (0.67, 0.45),
        (0.60, 0.35),
        (0.47, 0.32),
        (0.35, 0.35),
        (0.29, 0.28),
    ]
    radius_base = size * 0.062 * scale
    for index, (nx, ny) in enumerate(points):
        t = index / (len(points) - 1)
        x, y = point(nx, ny)
        color = mix(GREEN_DARK, GREEN_LIGHT if index == len(points) - 1 else GREEN_MID, t ** 0.82)
        radius = radius_base * (0.68 + t * 0.58)
        if index == len(points) - 1:
            glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            gd = ImageDraw.Draw(glow)
            gd.ellipse(
                [x - radius * 2.1, y - radius * 2.1, x + radius * 2.1, y + radius * 2.1],
                fill=(99, 255, 166, 70),
            )
            glow = glow.filter(ImageFilter.GaussianBlur(radius * 0.9))
            layer = Image.alpha_composite(layer, glow)
            draw = ImageDraw.Draw(layer)
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color + (255,))

    # 头部眼睛，朝右上
    head_x, head_y = point(*points[-1])
    head_r = radius_base * 1.26
    eye_r = head_r * 0.18
    for side in (-1, 1):
        ex = head_x + head_r * 0.18 + side * head_r * 0.33
        ey = head_y - head_r * 0.16 + side * head_r * 0.24
        draw.ellipse(
            [ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r],
            fill=(3, 24, 15, 242),
        )

    # 果实 + 柔和光晕
    fx, fy = point(0.73, 0.72)
    fruit_r = size * 0.105 * scale
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        [fx - fruit_r * 2.4, fy - fruit_r * 2.4, fx + fruit_r * 2.4, fy + fruit_r * 2.4],
        fill=(255, 93, 54, 86),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(fruit_r * 0.7))
    layer = Image.alpha_composite(layer, glow)
    draw = ImageDraw.Draw(layer)

    draw.ellipse(
        [fx - fruit_r, fy - fruit_r, fx + fruit_r, fy + fruit_r],
        fill=ORANGE + (255,),
    )
    draw.ellipse(
        [fx - fruit_r * 0.58, fy - fruit_r * 0.56, fx + fruit_r * 0.13, fy + fruit_r * 0.1],
        fill=ORANGE_LIGHT + (190,),
    )

    # 叶子
    leaf = [
        (fx + fruit_r * 0.08, fy - fruit_r * 0.9),
        (fx + fruit_r * 0.72, fy - fruit_r * 1.32),
        (fx + fruit_r * 0.55, fy - fruit_r * 0.62),
    ]
    draw.polygon(leaf, fill=(99, 238, 137, 255))
    draw.line(
        [(fx, fy - fruit_r * 0.6), (fx + fruit_r * 0.18, fy - fruit_r * 1.05)],
        fill=(50, 155, 87, 255),
        width=max(2, round(size * 0.011 * scale)),
    )

    return Image.alpha_composite(image, layer)


def make_icon(size: int, maskable: bool) -> Image.Image:
    large = size * SCALE
    image = make_background(large)
    image = draw_snake_and_fruit(image, maskable)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    outputs = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-192.png", 192, True),
        ("icon-maskable-512.png", 512, True),
    ]
    for name, size, maskable in outputs:
        path = ICON_DIR / name
        image = make_icon(size, maskable)
        image.save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({size}x{size}, {path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
