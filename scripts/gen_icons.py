# -*- coding: utf-8 -*-
"""
生成微信小程序 tabBar 图标（81x81 PNG，透明底）。
纯标准库实现（zlib + struct），无需 Pillow。

用法：python scripts/gen_icons.py
输出：miniprogram/images/tab/*.png
"""
import os
import struct
import zlib
import math

SIZE = 81
C = SIZE / 2.0


# ---------- PNG 编码 ----------
def write_png(path, pixels):
    """pixels: list of rows, each row is list of (r,g,b,a)"""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


# ---------- 形状（SDF，内部为正） ----------
def circle(x, y, cx, cy, r):
    return r - math.hypot(x - cx, y - cy)


def rect(x, y, cx, cy, w, h, r=0):
    dx = abs(x - cx) - w
    dy = abs(y - cy) - h
    if r <= 0:
        return -max(dx, dy)
    return -math.hypot(max(dx, 0), max(dy, 0)) - r if (dx > 0 or dy > 0) else -max(dx, dy)


def point_in_poly(x, y, pts):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def poly(x, y, pts):
    # 用距离边界的近似值做抗锯齿（内部为正、外部为负）
    if point_in_poly(x, y, pts):
        d = min(math.hypot(x - px, y - py) for px, py in pts)
        best = 1e9
        for i in range(len(pts)):
            px1, py1 = pts[i]
            px2, py2 = pts[(i + 1) % len(pts)]
            vx, vy = px2 - px1, py2 - py1
            t = max(0, min(1, ((x - px1) * vx + (y - py1) * vy) / (vx * vx + vy * vy)))
            best = min(best, math.hypot(x - (px1 + t * vx), y - (py1 + t * vy)))
        return best
    best = 1e9
    for i in range(len(pts)):
        px1, py1 = pts[i]
        px2, py2 = pts[(i + 1) % len(pts)]
        vx, vy = px2 - px1, py2 - py1
        t = max(0, min(1, ((x - px1) * vx + (y - py1) * vy) / (vx * vx + vy * vy)))
        best = min(best, math.hypot(x - (px1 + t * vx), y - (py1 + t * vy)))
    return -best


def op_union(*vals):
    return max(*vals)


def op_sub(a, b):
    return min(a, -b)


# ---------- 五个图标 ----------
def shape_home(x, y):
    roof = poly(x, y, [(C, 13), (70, 40), (11, 40)])
    body = rect(x, y, C, 54, 20, 14)
    door = rect(x, y, C, 60, 7, 8)
    chimney = rect(x, y, 55, 24, 3.5, 8)
    return op_union(op_sub(body, door), roof, chimney)


def shape_cat(x, y):
    head = circle(x, y, C, 44, 21)
    ear_l = poly(x, y, [(19, 30), (24, 10), (40, 27)])
    ear_r = poly(x, y, [(62, 30), (57, 10), (41, 27)])
    return op_union(head, ear_l, ear_r)


def shape_pin(x, y):
    top = circle(x, y, C, 34, 19)
    tail = poly(x, y, [(C, 70), (26, 42), (55, 42)])
    hole = circle(x, y, C, 34, 7)
    return op_sub(op_union(top, tail), hole)


def shape_grid(x, y):
    cells = []
    w, h = 9, 9
    for r in range(2):
        for c in range(3):
            cx = 20 + c * 21
            cy = 30 + r * 21
            cells.append(rect(x, y, cx, cy, w, h, r=2.5))
    return op_union(*cells)


def shape_mine(x, y):
    head = circle(x, y, C, 28, 12)
    body = circle(x, y, C, 74, 22)
    body = min(body, -(y - 66))  # 截掉下半部分
    return op_union(head, body)


SHAPES = {
    'home': shape_home,
    'cat': shape_cat,
    'map': shape_pin,
    'work': shape_grid,
    'mine': shape_mine,
}

COLORS = {
    'off': (154, 154, 154),
    'on': (255, 138, 61),
}


def render(shape_fn, color):
    r, g, b = color
    rows = []
    ss = 3  # 超采样
    step = 1.0 / ss
    for py in range(SIZE):
        row = []
        for px in range(SIZE):
            hits = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = px + (sx + 0.5) * step
                    y = py + (sy + 0.5) * step
                    if shape_fn(x, y) >= 0:
                        hits += 1
            cov = hits / float(ss * ss)
            if cov <= 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((r, g, b, int(round(255 * min(cov * 1.15, 1.0)))))
        rows.append(row)
    return rows


def main():
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'images', 'tab')
    base = os.path.normpath(base)
    os.makedirs(base, exist_ok=True)
    for name, fn in SHAPES.items():
        for state, color in COLORS.items():
            suffix = '_on' if state == 'on' else ''
            path = os.path.join(base, name + suffix + '.png')
            write_png(path, render(fn, color))
    print('done ->', base)


if __name__ == '__main__':
    main()
