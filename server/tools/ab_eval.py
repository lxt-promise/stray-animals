# -*- coding: utf-8 -*-
"""识别算法 A/B 评估台：同一批素材，改一个开关就看出区分度是涨是跌。

为什么需要它
------------
调 ReID 相关参数最怕「凭感觉」：余弦从 0.76 变成 0.78 到底是变好了还是
只是这张图碰巧？没有量化口径的优化等于掷骰子 —— 2026-10-24 连着两次
「改完以为更好、上线发现更差」（多尺度裁剪、单边翻转 TTA）都是这么来的。

本脚本固定素材、固定变体，只让被测开关在两次运行之间变化：

    ..\\env\\Scripts\\python.exe tools/ab_eval.py                 # 基线
    ..\\env\\Scripts\\python.exe tools/ab_eval.py --square        # 开方形折叠
    ..\\env\\Scripts\\python.exe tools/ab_eval.py --pad 0.12      # 改外扩

素材构成（刻意包含「背景」这一维）
----------------------------------
现场失败的典型不是「同一张图旋转 5°」，而是「同一只猫、另一处草坪、另一个光」。
所以每只猫生成 5 个变体：
    orig      原图
    grass     贴到草地绿背景（模拟户外最常见构图）
    wood      贴到木桌棕背景
    bright    提亮 1.25×（正午/闪光）
    dim       压暗 0.75×（傍晚/树荫）
同猫 = 同一只猫的不同变体；异猫 = 不同猫。背景鲁棒性只有这样才测得出来。

指标
----
  gap   = min(同猫) - max(异猫)，>0 表示存在一个阈值能完全分开（越大越稳）
  auc   = 随机取一对（同猫, 异猫），同猫得分更高的概率。0.5=瞎猜，1.0=完美。
          AUC 比 gap 稳健：gap 只看最差的那一对，容易被单个离群样本绑架。
  属性 = 每张图判出的花色，人工核对（素材文件名即标签）
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image, ImageEnhance, ImageFilter  # noqa: E402

from app import config, engine  # noqa: E402

DATA = Path(__file__).resolve().parents[1] / "data"


def grid_cats() -> dict:
    """把 data/_cats.jpeg 切成四格 → 四只不同的猫。"""
    p = DATA / "_cats.jpeg"
    if not p.exists():
        return {}
    g = Image.open(p).convert("RGB")
    W, H = g.size
    hw, hh = W // 2, H // 2
    return {
        "cat1": g.crop((0, 0, hw, hh)),
        "cat2": g.crop((hw, 0, W, hh)),
        "cat3": g.crop((0, hh, hw, H)),
        "cat4": g.crop((hw, hh, W, H)),
    }


def on_bg(im: Image.Image, color: tuple, scale: float = 0.82) -> Image.Image:
    """把猫缩到 82% 后贴到纯色背景中央 —— 模拟「猫 + 大片背景」的真实构图。"""
    w, h = im.size
    nw, nh = int(w * scale), int(h * scale)
    bg = Image.new("RGB", (w, h), color)
    bg.paste(im.resize((nw, nh), Image.BILINEAR), ((w - nw) // 2, (h - nh) // 2))
    return bg


def variants(im: Image.Image) -> dict:
    return {
        "orig": im,
        "grass": on_bg(im, (74, 118, 62)),
        "wood": on_bg(im, (150, 106, 68)),
        "bright": ImageEnhance.Brightness(im).enhance(1.25),
        "dim": ImageEnhance.Brightness(im).enhance(0.75),
        "blur": im.filter(ImageFilter.GaussianBlur(1.1)),
    }


def auc(pos: list, neg: list) -> float:
    """AUC：随机一对（正, 负），正例得分更高的概率。"""
    if not pos or not neg:
        return float("nan")
    p = np.asarray(pos, dtype=np.float64)
    n = np.asarray(neg, dtype=np.float64)
    return float(((p[:, None] > n[None, :]).sum()
                  + 0.5 * (p[:, None] == n[None, :]).sum()) / (p.size * n.size))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--square", action="store_true", help="开启 DETECT_COLLAPSE_SQUARE")
    ap.add_argument("--pad", type=float, default=None, help="覆盖 DETECT_PAD")
    ap.add_argument("--conf", type=float, default=None, help="覆盖 DETECT_CONF")
    ap.add_argument("--no-detect", action="store_true", help="关闭检测（对照：整图提特征）")
    args = ap.parse_args()

    if args.square:
        config.DETECT_COLLAPSE_SQUARE = True
    if args.pad is not None:
        config.DETECT_PAD = args.pad
    if args.conf is not None:
        config.DETECT_CONF = args.conf
    if args.no_detect:
        config.DETECT_AUTO = False

    config.REID_ONNX = config.REID_ONNX or "models/reid.onnx"
    eng = engine.get_engine()
    print("provider=%s dim=%s size=%s detector=%s  square=%s pad=%s conf=%s"
          % (eng.provider, eng.dim, eng.embedder.size, bool(eng.detector.sess),
             config.DETECT_COLLAPSE_SQUARE, config.DETECT_PAD, config.DETECT_CONF))

    cats = grid_cats()
    if not cats:
        print("缺少 data/_cats.jpeg")
        return

    rows = []
    for name, base in cats.items():
        for vname, im in variants(base).items():
            emb, detected, a = eng.features_ex(im)
            rows.append({"cat": name, "v": vname, "emb": emb,
                         "det": detected, "attr": a})

    print("\n=== 每张图 ===")
    for r in rows:
        a = r["attr"]
        print("  %-5s %-7s 检测=%s 花色=%-6s 纹理=%-6s conf=%.2f stripe=%.2f %s"
              % (r["cat"], r["v"], "是" if r["det"] else "否",
                 a["color"] or "-", a["pattern"] or "-",
                 a["confidence"], a["stripe"], a["reason"] or ""))

    intra, inter = [], []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            s = float(rows[i]["emb"] @ rows[j]["emb"])
            (intra if rows[i]["cat"] == rows[j]["cat"] else inter).append(s)

    print("\n=== 区分度 ===")
    print("  同猫 n=%d  min=%.4f 均值=%.4f" % (len(intra), min(intra), np.mean(intra)))
    print("  异猫 n=%d  max=%.4f 均值=%.4f" % (len(inter), max(inter), np.mean(inter)))
    print("  gap = %+.4f   auc = %.4f" % (min(intra) - max(inter), auc(intra, inter)))

    # 分变体看：哪个场景最伤（背景？亮度？模糊？）
    print("\n=== 分场景（该变体下 同猫min - 异猫max）===")
    for vname in variants(cats["cat1"]).keys():
        sub = [r for r in rows if r["v"] == vname]
        ii, ee = [], []
        for i in range(len(sub)):
            for j in range(i + 1, len(sub)):
                s = float(sub[i]["emb"] @ sub[j]["emb"])
                (ii if sub[i]["cat"] == sub[j]["cat"] else ee).append(s)
        if ii and ee:
            print("  %-7s gap=%+.4f auc=%.4f" % (vname, min(ii) - max(ee), auc(ii, ee)))

    det_rate = sum(1 for r in rows if r["det"]) / len(rows)
    print("\n  检测命中率 = %.0f%%（%d/%d）" % (det_rate * 100,
                                              sum(1 for r in rows if r["det"]), len(rows)))


if __name__ == "__main__":
    main()
