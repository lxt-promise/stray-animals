# -*- coding: utf-8 -*-
"""生成地图 marker 用的卡通猫头像图标。

样式参考（用户提供的卡园猫咪地图截图）：
  白底圆角气泡 + 卡通猫脸 + 下方短茎 + 底部状态圆点（绿=已绝育 / 橙=未绝育）

输出：miniprogram/images/marker-cartoon-{pattern}-{done|todo}.png
      pattern ∈ tabby/orange/cow/tuxedo/calico/white/black/gray
共 16 张，96x132（4 倍超采样绘制后缩小，抗锯齿）。
"""
import os
from PIL import Image, ImageDraw

S = 4                      # 超采样倍数
W, H = 96, 132             # 最终尺寸
w, h = W * S, H * S        # 画布尺寸

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', 'miniprogram', 'images')
os.makedirs(OUT, exist_ok=True)

# ---------- 调色板 ----------
FACE = {
    'tabby':        ((196, 148, 96), (150, 104, 58),  (120, 82, 46)),   # 狸花：棕底+深条纹
    'orange':       ((244, 168, 92), (226, 128, 48),  (196, 106, 36)),  # 橘猫
    'cow':          ((250, 250, 250), (58, 58, 62),   (40, 40, 44)),    # 奶牛：白底黑斑
    'tuxedo':       ((250, 250, 250), (52, 52, 58),    (36, 36, 42)),   # 燕尾服：白脸黑身
    'calico':       ((250, 248, 244), (58, 58, 62),    (214, 128, 52)), # 三花：白+黑+橘
    'white':        ((252, 252, 250), (232, 226, 216), (200, 190, 176)),# 纯白
    'black':        ((88, 84, 92),   (58, 56, 64),    (40, 38, 46)),    # 纯黑
    'gray':         ((168, 176, 190), (128, 138, 156), (96, 104, 122)), # 灰蓝
}
PINK = (244, 176, 190)       # 耳内/鼻子
INK = (62, 54, 66)           # 眼睛/嘴
WHITE = (255, 255, 255)
DOT_DONE = (47, 163, 107)    # 已绝育 绿
DOT_TODO = (249, 115, 22)    # 未绝育 橙


def rr(d, box, r, fill):
    """圆角矩形"""
    d.rounded_rectangle(box, radius=r, fill=fill)


def draw_face(d, cx, cy, R, base, dark, stripe):
    """画一张卡通猫脸：cx,cy 脸中心，R 脸半径"""
    # 耳朵（先画，压在脸下沿）
    ear_w, ear_h = R * 0.62, R * 0.78
    for sx in (-1, 1):
        ex = cx + sx * R * 0.62
        ey = cy - R * 0.72
        d.polygon([(ex - ear_w / 2, ey + ear_h * 0.55),
                   (ex + ear_w / 2, ey + ear_h * 0.55),
                   (ex + sx * R * 0.10, ey - ear_h * 0.45)], fill=base)
        # 耳内
        iw, ih = ear_w * 0.5, ear_h * 0.5
        d.polygon([(ex - iw / 2, ey + ih * 0.5),
                   (ex + iw / 2, ey + ih * 0.5),
                   (ex + sx * R * 0.08, ey - ih * 0.35)], fill=PINK)

    # 脸（圆）
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=base)

    # ---- 花色斑纹 ----
    if d.pattern == 'tabby':      # 额头 M 纹 + 腮纹
        for i, dx in enumerate((-0.34, 0.0, 0.34)):
            d.line([(cx + dx * R, cy - R * 0.62), (cx + dx * R * 1.15, cy - R * 0.28)],
                   fill=stripe, width=int(R * 0.13))
        for sx in (-1, 1):        # 腮侧条纹
            for k in range(2):
                yy = cy - R * 0.02 + k * R * 0.26
                d.arc([cx + sx * R * 0.62 - R * 0.22, yy - R * 0.12,
                       cx + sx * R * 0.62 + R * 0.22, yy + R * 0.12],
                      180 if sx < 0 else 0, 360 if sx < 0 else 180,
                      fill=stripe, width=int(R * 0.10))
    elif d.pattern == 'orange':   # 橘猫细条纹
        for dx in (-0.30, -0.10, 0.10, 0.30):
            d.line([(cx + dx * R, cy - R * 0.66), (cx + dx * R * 1.1, cy - R * 0.30)],
                   fill=stripe, width=int(R * 0.10))
    elif d.pattern in ('cow', 'tuxedo'):  # 黑斑块
        if d.pattern == 'cow':
            d.ellipse([cx - R * 0.78, cy - R * 0.42, cx - R * 0.10, cy + R * 0.26], fill=dark)
            d.ellipse([cx + R * 0.16, cy - R * 0.18, cx + R * 0.80, cy + R * 0.40], fill=dark)
        else:                     # tuxedo：白脸，头顶到耳后一圈黑
            d.pieslice([cx - R * 1.02, cy - R * 1.30, cx + R * 1.02, cy + R * 0.30],
                       180, 360, fill=dark)
    elif d.pattern == 'calico':   # 左右花色块 + 额头橘
        d.ellipse([cx - R * 0.88, cy - R * 0.40, cx - R * 0.06, cy + R * 0.30], fill=dark)
        d.ellipse([cx + R * 0.14, cy - R * 0.30, cx + R * 0.86, cy + R * 0.42], fill=stripe)
    elif d.pattern == 'black':    # 无斑纹，靠深色本身
        pass
    elif d.pattern == 'gray':     # 细纹
        for dx in (-0.26, 0.0, 0.26):
            d.line([(cx + dx * R, cy - R * 0.60), (cx + dx * R * 1.08, cy - R * 0.26)],
                   fill=stripe, width=int(R * 0.09))
    elif d.pattern == 'white':    # 浅灰阴影让白猫有轮廓
        d.arc([cx - R * 0.98, cy - R * 0.98, cx + R * 0.98, cy + R * 0.98],
              200, 340, fill=stripe, width=int(R * 0.07))

    # ---- 五官 ----
    eye_y = cy - R * 0.05
    for sx in (-1, 1):
        ex = cx + sx * R * 0.36
        d.ellipse([ex - R * 0.15, eye_y - R * 0.17, ex + R * 0.15, eye_y + R * 0.17], fill=INK)
        d.ellipse([ex - R * 0.06, eye_y - R * 0.09, ex + R * 0.04, eye_y + R * 0.01],
                  fill=WHITE)  # 高光
    # 鼻子（小三角）
    ny = cy + R * 0.24
    d.polygon([(cx - R * 0.09, ny), (cx + R * 0.09, ny), (cx, ny + R * 0.12)], fill=PINK)
    # 嘴（w）
    d.arc([cx - R * 0.20, ny + R * 0.02, cx, ny + R * 0.26], 20, 110, fill=INK,
          width=int(R * 0.055))
    d.arc([cx, ny + R * 0.02, cx + R * 0.20, ny + R * 0.26], 70, 160, fill=INK,
          width=int(R * 0.055))
    # 胡须
    for sx in (-1, 1):
        for k, dy in enumerate((-0.04, 0.08, 0.20)):
            x0 = cx + sx * R * 0.52
            x1 = cx + sx * R * 1.02
            yy = cy + R * dy
            d.line([(x0, yy), (x1, yy + sx * k * R * 0.02 - R * 0.01)],
                   fill=INK, width=max(2, int(R * 0.035)))


def make(pattern, done):
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.pattern = pattern   # 供 draw_face 内部分支读取
    base, dark, stripe = FACE[pattern]

    # ---- 底部状态圆点（先画，茎压在它上面）----
    dot_r = 13 * S
    dot_cy = h - dot_r - 4 * S
    d.ellipse([w / 2 - dot_r, dot_cy - dot_r, w / 2 + dot_r, dot_cy + dot_r],
              fill=DOT_DONE if done else DOT_TODO)
    d.ellipse([w / 2 - dot_r + 3 * S, dot_cy - dot_r + 3 * S,
               w / 2 + dot_r - 5 * S, dot_cy + dot_r - 7 * S],
              fill=(255, 255, 255, 60))

    # ---- 茎 ----
    stem_top = h - 52 * S
    d.rectangle([w / 2 - 2 * S, stem_top, w / 2 + 2 * S, dot_cy + dot_r - 2 * S],
                fill=(150, 144, 156, 255))

    # ---- 白底圆角气泡 ----
    bubble = [6 * S, 4 * S, w - 6 * S, h - 46 * S]
    # 阴影
    shadow = [bubble[0] + 2 * S, bubble[1] + 3 * S, bubble[2] + 2 * S, bubble[3] + 3 * S]
    d.rounded_rectangle(shadow, radius=26 * S, fill=(60, 50, 70, 40))
    # 本体
    rr(d, bubble, 24 * S, WHITE)
    d.rounded_rectangle(bubble, radius=24 * S, outline=(233, 226, 216, 255), width=2 * S)
    # 小尾巴（气泡下方的尖角，指向圆点）
    d.polygon([(w / 2 - 8 * S, bubble[3] - 6 * S),
               (w / 2 + 8 * S, bubble[3] - 6 * S),
               (w / 2, bubble[3] + 12 * S)], fill=WHITE)

    # ---- 猫脸 ----
    cx = w / 2
    cy = (bubble[1] + bubble[3]) / 2 + 2 * S
    R = 34 * S
    draw_face(d, cx, cy, R, base, dark, stripe)

    return img.resize((W, H), Image.LANCZOS)


count = 0
for p in FACE:
    for done in (True, False):
        img = make(p, done)
        name = 'marker-cartoon-%s-%s.png' % (p, 'done' if done else 'todo')
        img.save(os.path.join(OUT, name))
        count += 1
print('generated %d icons -> %s' % (count, os.path.normpath(OUT)))
