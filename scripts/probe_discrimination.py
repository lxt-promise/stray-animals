"""实测 ReID 特征的判别力：mean-pool vs CLS token。

背景：线上两只不同颜色的猫，余弦相似度高达 0.953（展示分 97%）——判别力不足。
当前 _pool 对 ViT 输出 [1, 257, 768] 取 token 平均（含 CLS）。
DINOv2 类模型的共识是 CLS token 判别力远强于 patch mean（patch mean 混入大量
背景/纹理低频信息，天然把不同图推高到 0.9+）。

本脚本用本地真实照片两两算余弦，输出三种池化策略的对比矩阵：
  mean   —— 现状（全 token 平均）
  cls    —— 只取第一个 token（DINOv2 官方推荐用于检索/分类）
  nopatch—— patch token 平均（去掉 CLS）

用法：python scripts/probe_discrimination.py img1.jpg img2.jpg ...
不传参则自动用 server/data 与 web/backend/uploads 下能找到的图片。
"""
import glob
import os
import sys

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
sys.path.insert(0, SERVER)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app import config, engine  # noqa: E402


def token_matrix(im):
    """返回 [257, 768] 的 last_hidden_state。"""
    x = engine._to_nchw(im, eng.embedder.size, config.IMAGENET_MEAN, config.IMAGENET_STD)
    return eng.embedder.sess.run(None, {eng.embedder.input_name: x})[0][0]


def cos(a, b):
    n = np.linalg.norm(a) * np.linalg.norm(b)
    return float(a @ b / n) if n else 0.0


def variants(im):
    h = token_matrix(im)
    return {
        "mean": h.mean(axis=0),
        "cls": h[0],
        "nopatch": h[1:].mean(axis=0),
    }


def main():
    paths = sys.argv[1:]
    if not paths:
        cands = []
        cands += glob.glob(os.path.join(SERVER, "data", "*.jpg"))
        cands += glob.glob(os.path.join(SERVER, "..", "web", "backend", "uploads", "*", "*.jpg"))[:3]
        cands += [os.path.join(os.path.dirname(SERVER), "头像.jpg")]
        paths = [p for p in cands if os.path.exists(p)][:5]
    if len(paths) < 2:
        print("需要至少 2 张图片")
        sys.exit(1)

    print("引擎 provider=%s size=%s dim=%s" % (
        eng.provider, eng.embedder.size, eng.embedder.dim))
    print("图片 %d 张：" % len(paths))
    for p in paths:
        print("  ", os.path.basename(p))

    feats = {k: [] for k in ("mean", "cls", "nopatch")}
    for p in paths:
        im = Image.open(p)
        v = variants(im)
        for k in feats:
            feats[k].append(v[k])

    for key in ("mean", "cls", "nopatch"):
        print("\n== 池化策略 %s ==" % key)
        n = len(paths)
        vals = []
        for i in range(n):
            for j in range(i + 1, n):
                c = cos(feats[key][i], feats[key][j])
                vals.append(c)
                print("  %s vs %s : %.4f" % (
                    os.path.basename(paths[i])[:24], os.path.basename(paths[j])[:24], c))
        # 判别力指标：pair 间余弦的最大值（越低越好）与均值
        print("  --> max=%.4f  mean=%.4f  (越低判别力越好；>0.9 基本不可用)" % (
            max(vals), sum(vals) / len(vals)))


if __name__ == "__main__":
    eng = engine.get_engine()
    main()
