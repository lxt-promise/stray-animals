# -*- coding: utf-8 -*-
"""属性诊断台：打印一张图在不同曝光下的**色桶占比明细**。

为什么需要它：只看最终 color/pattern 无法定位问题 —— 「判成玳瑁」背后可能是
白块掉进灰桶、也可能是暖色掉进棕桶，两种修法完全不同。本脚本把中间量
（各色桶占比 / 暗灰 / 条纹 / 曝光分位）全部打出来，改阈值前先看清楚。

跑法：
    ..\\env\\Scripts\\python.exe tools/attr_probe.py data/_cats.jpeg
    ..\\env\\Scripts\\python.exe tools/attr_probe.py data/probe/xxx.png --crop 0
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image, ImageEnhance  # noqa: E402

from app import config, engine  # noqa: E402
from app.attrs import _BUCKETS, _CAT_BUCKETS  # noqa: E402

FACTORS = [0.60, 0.70, 0.80, 0.90, 1.00, 1.10, 1.25, 1.40]


def stats(im: Image.Image, cropped: bool):
    """取 attrs 的中间量（含曝光平移），外加曝光分位数。"""
    from app import attrs as A
    rgb = im.convert("RGB")
    small = rgb.resize((A._SIZE, A._SIZE), Image.BILINEAR)
    hsv = np.asarray(small.convert("HSV"))
    v = hsv[..., 2].astype(np.float32)
    weight = (np.ones((A._SIZE, A._SIZE), dtype=np.float64) if cropped
              else A._center_weight(A._SIZE, A._SIZE))

    st = A._stats_of(rgb, cropped)
    if st is None:
        return {b: 0.0 for b in _BUCKETS}, 0.0, 0.0, {"p10": 0, "p50": 0, "p90": 0, "p98": 0}

    q = lambda p: A._wquantile(v, weight, p)
    return (st["ratio"], st["dgray"], st["stripe"],
            {"p10": q(.10), "p50": q(.50), "p90": q(.90), "p98": q(.98)})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default="data/_cats.jpeg")
    ap.add_argument("--crop", type=int, default=1, help="1=视为已裁剪（不压边缘）")
    ap.add_argument("--grid", action="store_true", help="把图切成四格分别看")
    ap.add_argument("--detect", action="store_true",
                    help="走生产路径：改亮度后先检测猫体、用紧绷框裁剪，再判花色")
    args = ap.parse_args()

    config.REID_ONNX = config.REID_ONNX or "models/reid.onnx"
    eng = engine.get_engine()

    src = Image.open(args.path).convert("RGB")
    parts = {}
    if args.grid:
        W, H = src.size
        hw, hh = W // 2, H // 2
        parts = {"左上": src.crop((0, 0, hw, hh)), "右上": src.crop((hw, 0, W, hh)),
                 "左下": src.crop((0, hh, hw, H)), "右下": src.crop((hw, hh, W, H))}
    else:
        parts = {"整图": src}

    for pname, base in parts.items():
        print("\n" + "=" * 96)
        print("【%s】%s  cropped=%s" % (pname, args.path, bool(args.crop)))
        print("=" * 96)
        hdr = "亮度  " + "".join("%-8s" % b[:6] for b in _CAT_BUCKETS)
        print(hdr + "  暗灰   条纹   p10/p50/p90/p98       结论")
        for f in FACTORS:
            im = ImageEnhance.Brightness(base).enhance(f)
            if args.detect:
                # 生产路径：检测 → 紧绷框裁剪 → 属性。顺序不能反 ——
                # 先裁剪再改亮度就不是真实链路了（真实是"拍了张暗照片"）。
                det = engine._run_detect(eng.detector, im)
                core = det.get("core") or det.get("box")
                probe = im.crop(core) if core else im
                got = bool(core)
            else:
                probe, got = im, None
            ratio, dgray, stripe, qs = stats(probe, True)
            a = eng.attrs(probe, cropped=True)
            line = "%.2f  " % f
            if args.detect:
                line = line[:6] + ("检" if got else "未") + " " + line[6:]
            line += "".join("%-8.3f" % ratio[b] for b in _CAT_BUCKETS)
            line += "  %.3f  %.3f  " % (dgray, stripe)
            line += "%3.0f/%3.0f/%3.0f/%3.0f   " % (qs["p10"], qs["p50"], qs["p90"], qs["p98"])
            line += "%s/%s" % (a["color"] or "-", a["pattern"] or "-")
            print(line)


if __name__ == "__main__":
    main()
