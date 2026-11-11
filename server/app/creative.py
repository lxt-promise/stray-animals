# -*- coding: utf-8 -*-
"""小程序创意图像接口的实现：一键抠图 / 大头照 / 相册拼图。

三个能力共享同一条底座：检测（engine.detector）+ 抠图（matting.foreground）。
与识别链路刻意解耦 —— 这里**不**做质量门控、不抛"抠图失败"，
用户传什么就给什么结果（大不了整图无抠），诊断信息放在返回字段里。

所有函数输入 PIL.Image，输出 (PNG bytes, meta dict)，由 main.py 转 base64。
"""
from __future__ import annotations

import io
import math
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import config, matting

# 相册/大头照用的马卡龙底色板（RGB）。选低饱和高明度：白猫/黑猫上去都有对比，
# 又不会抢走主体。循环取用，相邻格不同色。
PALETTE = [
    (214, 234, 248),   # 浅蓝
    (250, 219, 216),   # 浅粉
    (213, 245, 227),   # 浅绿
    (252, 243, 207),   # 浅黄
    (232, 218, 239),   # 浅紫
    (250, 229, 211),   # 浅橘
]

# 单格 / 大头照的默认输出边长。PNG 体积与边长平方成正比，512 兼顾清晰度与流量。
CELL_SIZE = 512
PORTRAIT_SIZE = 512


def _png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _foreground_mask(im: Image.Image) -> Tuple[Optional[np.ndarray], dict]:
    """抠图掩膜 + 诊断。失败时 mask=None（调用方退化为原图）。"""
    fg = matting.foreground(im)
    if not fg.get("ok") or fg.get("mask") is None:
        return None, {"matted": False}
    cov = float(fg.get("coverage") or 0.0)
    return fg["mask"], {
        "matted": True,
        "box": fg.get("box"),
        "coverage": round(cov, 4),
        "tight": round(float(fg.get("tight") or 0.0), 4),
        # 与识别链路的门控同口径：低于它说明抠图基本没认出主体，
        # 结果大概率是「大部分像素被抠没了」，让前端可以提示换图。
        "lowCoverage": cov < float(getattr(config, "MATTING_MIN_COVERAGE", 0.10)),
    }


def _apply_alpha(im: Image.Image, mask: np.ndarray) -> Image.Image:
    """RGB + mask → RGBA 透明底图。"""
    if mask.shape[:2] != (im.size[1], im.size[0]):
        mask_img = Image.fromarray((mask * 255).astype(np.uint8)).resize(im.size, Image.LANCZOS)
        mask = np.asarray(mask_img, dtype=np.float32) / 255.0
    base = np.asarray(im.convert("RGB"), dtype=np.uint8)
    alpha = (mask * 255).astype(np.uint8)
    return Image.fromarray(np.dstack([base, alpha]), mode="RGBA")


def _content_box(im: Image.Image, mask: Optional[np.ndarray]) -> Tuple[int, int, int, int]:
    """主体外接框：有掩膜用掩膜的，否则整图。"""
    if mask is None:
        return (0, 0, im.size[0], im.size[1])
    thr = float(getattr(config, "MATTING_ALPHA_THR", 0.5))
    ys, xs = np.where(mask > thr)
    if not len(xs):
        return (0, 0, im.size[0], im.size[1])
    # 掩膜是原图尺寸（matting.foreground 已上采样回来），直接用
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def _fit_square(rgba: Image.Image, size: int, bg: Tuple[int, int, int],
                fill: float = 0.86) -> Image.Image:
    """把透明底主体等比缩放到 size×size 的纯色底中央（主体占 fill 比例）。"""
    canvas = Image.new("RGB", (size, size), bg)
    if rgba.width == 0 or rgba.height == 0:
        return canvas
    scale = min(size * fill / rgba.width, size * fill / rgba.height)
    nw, nh = max(1, int(rgba.width * scale)), max(1, int(rgba.height * scale))
    obj = rgba.resize((nw, nh), Image.LANCZOS)
    canvas.paste(obj, ((size - nw) // 2, (size - nh) // 2), obj)
    return canvas


# ---------------- ① 一键抠图 ----------------
def cutout(im: Image.Image, bg: str = "transparent") -> Tuple[bytes, dict]:
    """抠图主流程。

    bg:
      transparent —— 输出 RGBA 透明底 PNG（默认，小程序端可自由再合成）
      gray        —— 中性灰底（与识别链路口径一致）
      #RRGGBB     —— 指定纯色底
    """
    mask, meta = _foreground_mask(im)
    rgba = _apply_alpha(im, mask) if mask is not None else im.convert("RGBA")
    if bg == "transparent" or not bg:
        return _png_bytes(rgba), meta
    color = (128, 128, 128) if bg == "gray" else _parse_hex(bg, (255, 255, 255))
    canvas = Image.new("RGBA", rgba.size, color + (255,))
    canvas.alpha_composite(rgba)
    return _png_bytes(canvas.convert("RGB")), meta


def _parse_hex(s: str, default: Tuple[int, int, int]) -> Tuple[int, int, int]:
    try:
        s = s.lstrip("#")
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except Exception:  # noqa: BLE001
        return default


# ---------------- ② 大头照 ----------------
def portrait(im: Image.Image, size: int = PORTRAIT_SIZE,
             bg: str = "") -> Tuple[bytes, dict]:
    """方形圆形徽章大头照：检测猫头区域 → 抠图 → 贴到圆形底色徽章中央。

    头部取法：优先用检测框的上 55%（猫照里耳朵+脸通常在框的上半部），
    检测不到就用抠图掩膜的外接框上 55%，再不行整图居中。
    """
    from .engine import get_engine  # 延迟引入，避免模块级加载引擎

    det = get_engine().detector
    d = det.detect(im) if det is not None else {"box": None}
    box = d.get("box")

    mask, meta = _foreground_mask(im)
    rgba = _apply_alpha(im, mask) if mask is not None else im.convert("RGBA")

    if box:
        x1, y1, x2, y2 = [int(v) for v in box]
        detected = True
    else:
        x1, y1, x2, y2 = _content_box(im, mask)
        detected = False
    # 头部定位：取掩膜里最靠上的 25% 像素（耳朵+头顶必然在其中）的质心。
    # 站立侧身的猫，检测框中心是胸口不是头 —— 用框中心会把大头照拍成半身照。
    hh_total = max(1, y2 - y1)
    hh = int(hh_total * 0.30)      # 猫头高度 ≈ 站立猫身高的 30%（实测 19 张标定）
    cx, cy = (x1 + x2) // 2, y1 + int(hh_total * 0.15) + hh // 2
    if mask is not None:
        thr = float(getattr(config, "MATTING_ALPHA_THR", 0.5))
        ys, xs = np.where(mask > thr)
        if len(xs):
            top_q = y1 + hh_total * 0.25
            sel = ys <= top_q
            if sel.sum() >= 32:          # 太少说明掩膜碎，退回经验值
                cx = int(np.median(xs[sel]))
                cy = int(np.median(ys[sel])) + int(hh * 0.45)
    # 边长 = 2×头高：装下耳朵到胸口，四周留呼吸感。用框宽做基准是错的 ——
    # 站立猫照框宽是全身长，会把整只猫拉回画面（2026-10-31 实测翻车）。
    side = int(hh * 2.0)
    sx1 = max(0, cx - side // 2); sy1 = max(0, cy - side // 2)
    sx2 = min(im.size[0], sx1 + side); sy2 = min(im.size[1], sy1 + side)
    # 贴边时重新对齐，保住正方形（否则缩放后头不居中）
    sx1 = max(0, sx2 - side); sy1 = max(0, sy2 - side)
    crop = rgba.crop((sx1, sy1, sx2, sy2))

    color = _parse_hex(bg, PALETTE[0]) if bg else PALETTE[0]
    out = _badge_circle(crop, size, color)
    meta["detected"] = detected
    meta["size"] = size
    return _png_bytes(out), meta


def _badge_circle(rgba: Image.Image, size: int, color: Tuple[int, int, int],
                  fill: float = 0.92) -> Image.Image:
    """圆形徽章：透明四角 + 纯色圆底 + 主体居中。当头像直接可用。"""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    margin = int(size * 0.02)
    draw.ellipse([margin, margin, size - margin, size - margin], fill=color + (255,))
    if rgba.width and rgba.height:
        scale = min(size * fill / rgba.width, size * fill / rgba.height)
        nw, nh = max(1, int(rgba.width * scale)), max(1, int(rgba.height * scale))
        obj = rgba.resize((nw, nh), Image.LANCZOS)
        canvas.alpha_composite(obj, ((size - nw) // 2, int((size - nh) * 0.55)))
    return canvas


# ---------------- ③ 相册拼图 ----------------
def album(items: List[Tuple[Image.Image, str]], cols: int = 0,
          cell: int = CELL_SIZE) -> Tuple[bytes, dict]:
    """多张猫照抠图后拼成马卡龙底网格相册。

    items: [(图片, 名字)]，名字为空不画字。cols=0 时自动（≤4 张 2 列，否则 3 列）。
    每张失败的图（没抠出来）退化为原图贴入，不缺席 —— 相册是纪念场景，
    「缺一张」比「这张没那么精致」更难接受。
    """
    n = len(items)
    if not n:
        raise ValueError("相册至少需要 1 张图片")
    if cols <= 0:
        cols = 2 if n <= 4 else 3
    rows = math.ceil(n / cols)

    pad = int(cell * 0.06)
    label_h = int(cell * 0.14)  # 底部名字条
    canvas_w = cols * cell + (cols + 1) * pad
    canvas_h = rows * (cell + label_h) + (rows + 1) * pad
    canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    font = _load_font(int(label_h * 0.55))

    matted, failed = 0, []
    for idx, (im, name) in enumerate(items):
        r, c = divmod(idx, cols)
        x0 = pad + c * (cell + pad)
        y0 = pad + r * (cell + label_h + pad)
        bg = PALETTE[idx % len(PALETTE)]
        mask, meta = _foreground_mask(im)
        rgba = _apply_alpha(im, mask) if mask is not None else im.convert("RGBA")
        if meta.get("matted"):
            matted += 1
        else:
            failed.append(idx)
        tile = _fit_square(rgba, cell, bg)
        canvas.paste(tile, (x0, y0))
        if name and font is not None:
            _draw_label(draw, name, x0, y0 + cell, cell, label_h, font, bg)

    return _png_bytes(canvas), {"count": n, "cols": cols, "rows": rows,
                                "matted": matted, "unmatttedIdx": failed,
                                "width": canvas_w, "height": canvas_h}


def _load_font(px: int) -> Optional[ImageFont.FreeTypeFont]:
    """尝试加载中文字体；容器里没有中文字体时返回 None（相册自动不画名字）。

    顺序：Windows 雅黑 → Noto CJK（Linux 常见）→ DejaVu（画不出中文但至少有字形）。
    """
    for path in ("C:/Windows/Fonts/msyh.ttc",
                 "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                 "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(path, px)
        except Exception:  # noqa: BLE001
            continue
    return None


def _draw_label(draw: ImageDraw.Draw, text: str, x: int, y: int,
                w: int, h: int, font, bg) -> None:
    """格子底部居中的名字条（底色稍深一档的同色系）。"""
    bar = tuple(max(0, int(v * 0.92)) for v in bg)
    draw.rectangle([x, y, x + w, y + h], fill=bar)
    try:
        tw = draw.textlength(text, font=font)
    except Exception:  # noqa: BLE001
        tw = w * 0.6
    tx = x + max(4, (w - tw) / 2)
    ty = y + (h - font.size) / 2
    draw.text((tx, ty), text, fill=(80, 80, 80), font=font)
