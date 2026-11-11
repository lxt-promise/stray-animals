"""复现「看图说话」式猫花色识别 —— 独立实现，不依赖 app/ 里的任何模块。

背景：多模态大模型识别那张奶牛猫时的推理过程是三步：

  1. 全局调色板：先扫一眼整张图，看有哪些毛色、各占多少
     （白 / 黑 / 灰 / 暖色），干扰物（人手、红袖子）是肤色/暖色，
     不属于猫的黑白毛色体系，直接归入暖色桶、不参与黑白判定；
  2. 空间布局：再看色块长在什么部位 —— 头顶和耳朵黑不黑、
     口鼻/胸口白不白、背部有没有大块黑斑、爪子是不是「白手套」、
     尾巴是不是纯黑；
  3. 规则判定：黑白两色成片共存 → 双色猫；白色成片且占比高 → 奶牛，
     白块很小（白围脖白爪）→ 燕尾服；暖色参与三色 → 三花；
     明暗周期性条纹 → 狸花；单色占绝对多数 → 纯色猫。

本脚本用 numpy + PIL 把这三步逐条翻译成代码：

  第 1 步 → HSV 逐像素色桶分类 + 中心加权（模拟「先看猫、忽略边缘背景」）；
  第 2 步 → 上/中/下三条水平带的分部位色占比 + 8×8 瓦片「斑块度」
           （黑白各占成片瓦片 = 大块斑块，而不是一团灰渐变）；
  第 3 步 → 规则表输出花色结论与证据。

用法：
  env\\Scripts\\python.exe tools\\pattern_recognize.py <图片路径> [--json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# 分析分辨率：128×128 够做色桶统计和分带统计，CPU 毫秒级
SIZE = 128

# 色桶编号：0 白 1 黑 2 灰 3 暖（橘/棕/肤色）4 其他
WHITE, BLACK, GRAY, WARM, OTHER = range(5)
BUCKET_NAMES = ("白", "黑", "灰", "暖", "其他")


# ---------------------------------------------------------------- 第 1 步
def load_image(path: str) -> Image.Image:
    im = Image.open(path).convert("RGB")
    return im.resize((SIZE, SIZE), Image.BILINEAR)


def center_weight() -> np.ndarray:
    """中心高斯权重：照片边缘（窗框、天空、墙）往往不是猫，
    权重向中心衰减，模拟人眼「聚焦主体、忽略四角」的注意力。"""
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    c = (SIZE - 1) / 2.0
    d = ((xx - c) / (SIZE * 0.42)) ** 2 + ((yy - c) / (SIZE * 0.42)) ** 2
    return np.exp(-0.5 * d)


def classify_buckets(im: Image.Image) -> np.ndarray:
    """逐像素归入 5 个色桶，返回 (SIZE, SIZE) int8 编号图。

    阈值按猫毛的典型 HSV 定：白毛 V 高 S 低；黑毛 V 低（反光暗灰
    并入黑，见 gray_or_black）；肤色/红袖/橘毛都是暖色相、S 高 ——
    这正是「人手干扰不改变黑白结论」的原因：它整片落进暖色桶。
    """
    hsv = np.asarray(im.convert("HSV")).astype(np.float32)
    h = hsv[..., 0] * (360.0 / 255.0)   # 色相 0~360
    s = hsv[..., 1]                     # 饱和 0~255
    v = hsv[..., 2]                     # 明度 0~255

    white = (v >= 175) & (s <= 60)
    black = v <= 70
    gray = (s <= 50) & ~white & ~black
    warm = (s >= 60) & (h >= 5) & (h <= 60)

    idx = np.full((SIZE, SIZE), OTHER, dtype=np.int8)
    for i, m in enumerate((white, black, gray, warm)):
        idx[m] = i
    return idx


def weighted_ratio(idx: np.ndarray, weight: np.ndarray) -> dict:
    """中心加权色桶占比（总和为 1，含 other）。"""
    counts = np.bincount(idx.ravel(), weights=weight.ravel(), minlength=5)
    total = float(counts.sum())
    return {i: float(counts[i]) / total for i in range(5)}


def drop_border_warm(idx: np.ndarray) -> tuple:
    """剔除「从画面边缘伸进来」的连通暖色块 —— 人手、衣袖、渔网等干扰物。

    对应我看图时「忽略人手干扰」的空间推理：手是**从画面外侧进入、
    与猫体相连**的肤色/衣料区域，而猫毛色块不会单独从边框长出来。
    实现：从四条边框上的暖色像素做洪泛填充，连通块整体归入 other；
    加一条保护 —— 连通块超过画面 40% 时不清（那更可能是一只
    橘猫本体占了画面，宁可不剔，不能把真毛色剔没）。
    返回 (新色桶图, 剔除像素占比)。"""
    warm = idx == WARM
    visited = np.zeros_like(warm, dtype=bool)
    stack = []
    h, w = warm.shape
    for x in range(w):
        for y in (0, h - 1):
            if warm[y, x]:
                stack.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if warm[y, x]:
                stack.append((y, x))
    while stack:
        y, x = stack.pop()
        if visited[y, x] or not warm[y, x]:
            continue
        visited[y, x] = True
        if y > 0:
            stack.append((y - 1, x))
        if y < h - 1:
            stack.append((y + 1, x))
        if x > 0:
            stack.append((y, x - 1))
        if x < w - 1:
            stack.append((y, x + 1))
    removed = float(visited.mean())
    if removed > 0.40:      # 保护：暖色连通块过大时不剔除
        return idx, 0.0
    out = idx.copy()
    out[visited] = OTHER
    return out, removed


# ---------------------------------------------------------------- 第 2 步
def band_report(idx: np.ndarray, weight: np.ndarray) -> dict:
    """上/中/下三条水平带的黑、白占比 → 对应「头顶/背部、躯干、四肢」。
    猫是水平动物，黑白斑块的纵向分布本身就携带部位信息。"""
    out = {}
    names = ("上1/3(头/背)", "中1/3(躯干)", "下1/3(腹/爪)")
    h = SIZE // 3
    for i, name in enumerate(names):
        sl = slice(i * h, SIZE if i == 2 else (i + 1) * h)
        sub, w = idx[sl], weight[sl]
        t = float(w.sum())
        out[name] = {
            "black": float(w[sub == BLACK].sum()) / t,
            "white": float(w[sub == WHITE].sum()) / t,
        }
    return out


def patchiness(idx: np.ndarray, weight: np.ndarray) -> float:
    """斑块度 0~1：8×8 瓦片里「单一色调占优（≥70%）」的瓦片占比。

    奶牛猫的物理本质是黑白**成片**：每片瓦片要么基本全白、要么基本全黑；
    而一只灰猫的光影渐变会让每块瓦片都黑白混杂。这是「双色」和
    「单色明暗」的关键区分，也是我看图时「黑白大块斑块」判断的量化。"""
    t = 16  # 128/8
    tiles_i = idx.reshape(8, t, 8, t).transpose(0, 2, 1, 3).reshape(64, -1)
    tiles_w = weight.reshape(8, t, 8, t).transpose(0, 2, 1, 3).reshape(64, -1)
    good = mono = 0
    for ti, tw in zip(tiles_i, tiles_w):
        if tw.sum() <= 0:
            continue
        bw = (tw[ti == BLACK].sum() + tw[ti == WHITE].sum()) / tw.sum()
        if bw < 0.3:
            continue        # 黑白占比过低的瓦片是背景（天空/墙），不计入分母
        good += 1
        fb = tw[ti == BLACK].sum() / max(tw[ti == BLACK].sum() + tw[ti == WHITE].sum(), 1e-6)
        if bw >= 0.5 and (fb >= 0.7 or fb <= 0.3):
            mono += 1
    return mono / good if good else 0.0


def stripe_score(im: Image.Image, drop: np.ndarray = None) -> float:
    """条纹显著度 0~1：明暗沿主方向的**周期性交替**带数。

    狸花条纹有 5 条以上明暗带；奶牛斑块边界只有 1~3 条。
    做法：取灰度图，沿梯度更强的方向逐行去趋势（减低频），
    数符号交变次数 —— 交变多 → 周期条纹，而非斑块边界。
    drop（被剔除的干扰物掩膜）区域填中位灰：窗框/衣袖的边缘
    不再贡献假交变。"""
    g = np.asarray(im.convert("L"), dtype=np.float32)
    if drop is not None:
        g = np.where(drop, float(np.median(g)), g)
    ex = float(np.abs(np.diff(g, axis=1)).mean())
    ey = float(np.abs(np.diff(g, axis=0)).mean())
    if max(ex, ey) < 8.0:
        return 0.0
    rows = g if ex >= ey else g.T
    k = max(4, rows.shape[1] // 8)
    ker = np.ones(k, dtype=np.float32) / k
    bands = []
    for row in rows[::8]:
        if row.size < 2 * k + 2:
            continue
        r = row - np.convolve(row, ker, mode="same")
        r = r[k:-k]
        if r.size < 4:
            continue
        bands.append(int(np.sum(np.diff(np.sign(r)) != 0)) / 2.0)
    if not bands:
        return 0.0
    return min(1.0, float(np.median(bands)) / 9.0)


# ---------------------------------------------------------------- 第 3 步
def decide(r: dict, bands: dict, patch: float, stripe: float) -> tuple:
    """规则表：输入全局占比 / 分带占比 / 斑块度 / 条纹分，
    返回 (枚举值, 中文名, 证据说明列表)。规则顺序即优先级。"""
    white, black, warm = r[WHITE], r[BLACK], r[WARM]
    gray = r[GRAY]
    dark = black + 0.5 * gray          # 有效暗色（黑毛反光常落灰桶）
    light = white + 0.5 * gray         # 有效浅色（阴影里的白毛）
    ev = []

    top = bands["上1/3(头/背)"]
    mid = bands["中1/3(躯干)"]
    bot = bands["下1/3(腹/爪)"]

    # 规则 1：三色共存 → 三花（白 + 黑 + 暖，缺一不可）
    if white >= 0.12 and dark >= 0.08 and warm >= 0.15:
        ev.append(f"白 {white:.2f} + 暗 {dark:.2f} + 暖 {warm:.2f} 三色共存")
        return "calico", "三花猫", ev

    # 规则 2：暖色主导 → 橘猫 / 狸花（条纹分高 → 狸花）
    if warm >= 0.35 and warm >= dark:
        ev.append(f"暖色主导（{warm:.2f}），条纹分 {stripe:.2f}")
        if stripe >= 0.45:
            return "tabby", "狸花猫", ev
        return "orange", "橘猫", ev

    # 规则 3：有真条纹且暗色够量 → 狸花。
    # 🔴 必须有暖色底毛：狸花的物理本质是「暖黄褐底毛 + 深色条纹」；
    # 而窗框/栏杆/黑白斑块边界的明暗交替同样能刷高条纹分 —— 没有暖色
    # 毛的「条纹」只能来自环境纹理或斑块边界，不能凭空给猫长条纹。
    if stripe >= 0.55 and dark >= 0.15 and warm >= 0.15:
        ev.append(f"明暗周期条纹（{stripe:.2f}）+ 暖色底毛（{warm:.2f}）+ 暗色 {dark:.2f}")
        return "tabby", "狸花猫", ev

    # 规则 4：黑白双色调 + 斑块感 → 奶牛 / 燕尾服
    # 条件：暖色少（排除人手/红袖干扰与橘系）、灰不主导（排除灰猫渐变）、
    # 黑白都够量、且色块成片（patchiness 高）
    if (warm <= 0.25 and gray <= 0.35 and light >= 0.20 and dark >= 0.12
            and patch >= 0.35):
        ev.append(f"黑白双色（白 {white:.2f} / 黑 {black:.2f}），"
                  f"斑块度 {patch:.2f}，条纹分 {stripe:.2f}（斑块非条纹）")
        # 空间证据：上带黑多 = 头顶/背部黑斑；下带白多 = 白腹白爪
        if top["black"] >= 0.15 and bot["white"] >= 0.30:
            ev.append(f"上 1/3 黑占比 {top['black']:.2f}（头顶/背黑斑），"
                      f"下 1/3 白占比 {bot['white']:.2f}（白腹/白手套）")
        # 白块成片且可观 → 奶牛；白块很小（白围脖白爪）→ 燕尾服
        if white >= 0.20 or light >= 0.35:
            return "cow", "黑白奶牛猫", ev
        return "tuxedo", "燕尾服猫", ev

    # 规则 5：单色占绝对多数 → 纯色猫
    if white >= 0.55:
        ev.append(f"白色占绝对多数（{white:.2f}）")
        return "white", "纯白猫", ev
    if dark >= 0.55:
        ev.append(f"暗色占绝对多数（{dark:.2f}）")
        return "black", "纯黑猫", ev
    if gray >= 0.45:
        ev.append(f"灰色主导（{gray:.2f}）")
        return "gray", "灰猫", ev

    return "", "无法判断（颜色不集中）", [f"白 {white:.2f} / 黑 {black:.2f} / "
                                          f"灰 {gray:.2f} / 暖 {warm:.2f}"]


# ---------------------------------------------------------------- 主流程
def recognize(path: str) -> dict:
    im = load_image(path)
    weight = center_weight()
    idx = classify_buckets(im)

    # 空间抗干扰：从画面边缘伸进来的连通暖色块（人手/衣袖）整块剔除，
    # 再用干净的色桶图做全部统计 —— 对应我看图时「忽略人手干扰」。
    idx, removed = drop_border_warm(idx)
    drop = idx == OTHER
    if removed <= 0:
        drop = None

    ratio = weighted_ratio(idx, weight)
    bands = band_report(idx, weight)
    patch = patchiness(idx, weight)
    stripe = stripe_score(im, drop)

    value, label, evidence = decide(ratio, bands, patch, stripe)

    return {
        "image": path,
        "palette": {BUCKET_NAMES[i]: round(ratio[i], 3) for i in range(5)},
        "bands": {k: {c: round(v, 2) for c, v in d.items()} for k, d in bands.items()},
        "patchiness": round(patch, 3),
        "stripe": round(stripe, 3),
        "interference_removed": round(removed, 3),
        "pattern": value or "unknown",
        "breed": label,
        "evidence": evidence,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="看图说话式猫花色识别")
    ap.add_argument("image", help="图片路径")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    if not Path(args.image).is_file():
        print(f"图片不存在：{args.image}", file=sys.stderr)
        return 2

    result = recognize(args.image)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"图片：{result['image']}")
        print(f"调色板：{result['palette']}")
        for band, d in result["bands"].items():
            print(f"  {band}: 黑 {d['black']:.2f} / 白 {d['white']:.2f}")
        print(f"斑块度：{result['patchiness']}   条纹分：{result['stripe']}")
        print(f"结论：{result['breed']}（pattern={result['pattern']}）")
        for e in result["evidence"]:
            print(f"  - {e}")
    return 0 if result["pattern"] != "unknown" else 1


if __name__ == "__main__":
    sys.exit(main())
