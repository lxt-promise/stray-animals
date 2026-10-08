# -*- coding: utf-8 -*-
"""用真实猫照片重测相似度分布 —— 合成素材模板一致，无法反映真实区分度。

输出：
  1) 四只真猫两两之间的余弦相似度
  2) 同猫不同变换（旋转/裁剪/亮度/模糊）的相似度
  3) 与完全无关图片的相似度
用于确定 SIM_LOW / SIM_HIGH 该标在多少。
"""
from __future__ import annotations

import io
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter  # noqa: E402

from app import config, engine  # noqa: E402

config.REID_ONNX = "models/reid.onnx"
eng = engine.get_engine()
print("provider:", eng.provider, "dim:", eng.dim, "\n")

DATA = Path(__file__).resolve().parents[1] / "data"
DATA.mkdir(exist_ok=True)


def ensure_grid() -> Image.Image:
    p = DATA / "_cats.jpeg"
    if not p.exists():
        u = "https://hf-mirror.com/datasets/huggingface/documentation-images/resolve/main/cats.jpeg"
        p.write_bytes(urllib.request.urlopen(
            urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read())
    return Image.open(p).convert("RGB")


grid = ensure_grid()
print("原图尺寸:", grid.size)
W, H = grid.size
half_w, half_h = W // 2, H // 2

# 四格 -> 四只不同的猫
quads = {
    "cat1 (左上)": grid.crop((0, 0, half_w, half_h)),
    "cat2 (右上)": grid.crop((half_w, 0, W, half_h)),
    "cat3 (左下)": grid.crop((0, half_h, half_w, H)),
    "cat4 (右下)": grid.crop((half_w, half_h, W, H)),
}

# 无关对照图
stripe = Image.new("RGB", (512, 512), (255, 255, 255))
dd = ImageDraw.Draw(stripe)
for i in range(0, 512, 32):
    dd.rectangle([i, 0, i + 16, 512], fill=(30, 90, 160))
others = {"条纹图": stripe}

print("\n正在提取特征 ...")
emb = {}
for k, v in list(quads.items()) + list(others.items()):
    e, _, _, _, _ = eng.features(v)
    emb[k] = e

keys = list(emb)
print("\n=== 真实猫照片：余弦相似度矩阵 ===")
print("            " + "".join(f"{k[:6]:>9}" for k in keys))
for i in keys:
    print(f"{i:>12}" + "".join(f"{float(emb[i] @ emb[j]):>9.4f}" for j in keys))

# 同猫 + 变换
base = quads["cat1 (左上)"]
variants = {
    "原图": base,
    "旋转-12°": base.rotate(-12, resample=Image.BICUBIC),
    "亮度x1.25": ImageEnhance.Brightness(base).enhance(1.25),
    "中心裁70%": base.crop((int(base.width * .15), int(base.height * .15),
                            int(base.width * .85), int(base.height * .85))).resize(base.size),
    "模糊1.2": base.filter(ImageFilter.GaussianBlur(1.2)),
    "水平翻转": base.transpose(Image.FLIP_LEFT_RIGHT),
}
print("\n=== 同一只猫的不同拍摄条件 cat1 vs 变换 ===")
for name, v in variants.items():
    e, _, _, _, _ = eng.features(v)
    print(f"  {name:<12} {float(emb['cat1 (左上)'] @ e):.4f}")

same_stats = []
for name, v in variants.items():
    if name == "原图":
        continue
    e, _, _, _, _ = eng.features(v)
    same_stats.append(float(emb["cat1 (左上)"] @ e))

cross = [float(emb[i] @ emb[j]) for i, j in
         [("cat1 (左上)", "cat2 (右上)"), ("cat1 (左上)", "cat3 (左下)"),
          ("cat1 (左上)", "cat4 (右下)"), ("cat2 (右上)", "cat3 (左下)"),
          ("cat2 (右上)", "cat4 (右下)"), ("cat3 (左下)", "cat4 (右下)")]]
neg = [float(emb["cat1 (左上)"] @ emb["条纹图"]),
       float(emb["cat2 (右上)"] @ emb["条纹图"])]

print(f"\n=== 汇总 ===")
print(f"  同一只猫（含变换）: min={min(same_stats):.4f}  max={max(same_stats):.4f}  均值={sum(same_stats)/len(same_stats):.4f}")
print(f"  不同猫之间        : min={min(cross):.4f}  max={max(cross):.4f}  均值={sum(cross)/len(cross):.4f}")
print(f"  猫 vs 无关图      : min={min(neg):.4f}  max={max(neg):.4f}  均值={sum(neg)/len(neg):.4f}")
print(f"\n  建议 SIM_LOW  ≈ {sum(neg)/len(neg):.3f}")
print(f"  建议 SIM_HIGH ≈ {(sum(cross)/len(cross) + max(same_stats))/2:.3f}"
      f"（不同猫均值与同猫最高值取中）")
