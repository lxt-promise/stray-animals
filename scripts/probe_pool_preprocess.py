"""决定性实验：池化策略 × 预处理方式 对 ReID 判别力的影响。

背景：线上两只不同颜色的猫余弦 0.953（展示分 97%），用户无法接受。
当前实现：_letterbox（灰边补齐）+ 全 token 平均（含 CLS）。
两个已知的判别力杀手：
  1. mean-pool 混入大量背景/纹理 patch，把不同图推向 0.9+；DINOv2 官方推荐 CLS。
  2. letterbox 的灰边在猫占比小的图里产生大片「一致」patch，进一步抬高基线；
     timm/DINOv2 标准预处理是直接 resize 到正方形。

实验矩阵（6 组）：
  {mean, cls, nopatch} × {letterbox, resize}
每组输出：3 张不同颜色猫照的两两余弦（类间，越低越好）+ 同一只猫裁剪版的余弦（类内，越高越好）。
判据：类间 max 越低、类内越高 → 「类内-类间间隔」越大越好。

用法：python scripts/probe_pool_preprocess.py img1 [img2 ...]
"""
import glob
import os
import sys

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
sys.path.insert(0, SERVER)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app import config, engine  # noqa: E402

MEAN = np.array(config.IMAGENET_MEAN, dtype=np.float32)
STD = np.array(config.IMAGENET_STD, dtype=np.float32)


def to_nchw(im, size, mode):
    im = im.convert("RGB")
    if mode == "letterbox":
        im = engine._letterbox(im, size)
    else:  # resize：DINOv2/timm 标准做法（直接拉伸到正方形）
        im = im.resize((size, size), Image.BICUBIC)
    a = np.asarray(im, dtype=np.float32) / 255.0
    a = (a - MEAN) / STD
    return np.transpose(a, (2, 0, 1))[None, ...]


def hidden(im, size, mode):
    x = to_nchw(im, size, mode)
    return eng.embedder.sess.run(None, {eng.embedder.input_name: x})[0][0]


def cos(a, b):
    n = np.linalg.norm(a) * np.linalg.norm(b)
    return float(a @ b / n) if n else 0.0


def pool_variants(h):
    return {"mean": h.mean(axis=0), "cls": h[0], "nopatch": h[1:].mean(axis=0)}


def label(p):
    return os.path.basename(p)[:20]


def main():
    paths = sys.argv[1:]
    if len(paths) < 3:
        print("需要至少 3 张图片")
        sys.exit(1)
    size = eng.embedder.size
    print("provider=%s size=%d  图片 %d 张" % (eng.provider, size, len(paths)))
    for p in paths:
        print("  ", label(p))

    # 类间：不同猫两两余弦
    inter = {}   # (pool, mode) -> list[cos]
    # 类内：同一张图裁掉 35% 右下（模拟换个角度/构图拍同一只）
    intra = {}
    crops = []
    for p in paths:
        im = Image.open(p)
        w, h = im.size
        crops.append(im.crop((0, 0, int(w * 0.65), int(h * 0.65))))
        crops[-1].load()

    for mode in ("letterbox", "resize"):
        Hs = [hidden(Image.open(p), size, mode) for p in paths]
        Hc = [hidden(c, size, mode) for c in crops]
        for pool in ("mean", "cls", "nopatch"):
            key = (pool, mode)
            vs = [pool_variants(h)[pool] for h in Hs]
            vc = [pool_variants(h)[pool] for h in Hc]
            pairs = [cos(vs[i], vs[j]) for i in range(len(vs)) for j in range(i + 1, len(vs))]
            same = [cos(vc[i], vs[i]) for i in range(len(vs))]
            inter[key] = pairs
            intra[key] = same

    print("\n%-22s %-28s %-24s %s" % ("策略", "类间(不同猫) max/mean", "类内(同猫裁剪) mean", "间隔"))
    rows = []
    for key in inter:
        mx, mn = max(inter[key]), sum(inter[key]) / len(inter[key])
        im_ = sum(intra[key]) / len(intra[key])
        gap = im_ - mx
        rows.append((gap, key, mx, mn, im_))
        print("%-22s %-28s %-24s %+.4f" % (
            "%s + %s" % key,
            "%.4f / %.4f" % (mx, mn),
            "%.4f" % im_,
            gap))
    rows.sort(reverse=True)
    print("\n判别力最优（类内-类间间隔最大）：", "%s + %s" % rows[0][1])
    print("（类间 max 应显著 < 类内 mean；间隔越大，99%/97% 这种贴脸分数越不可能出现）")


if __name__ == "__main__":
    eng = engine.get_engine()
    main()
