# -*- coding: utf-8 -*-
"""用**真实照片**复测「同一只猫 vs 不同猫」的相似度分布和最终展示分。

为什么需要它：`_realcat_probe.py` 测的是「同一张照片做旋转/翻转」，那只能说明
模型对自己人认得准；而现场出问题的是「同一只猫、另一张照片、另一个背景」。
两种分布的差别极大（本机实测：同图变换 0.96~0.996，同猫换图只有 0.69~0.76），
拿前者的数字去定 `SIM_MID` 会定得离谱高 —— 2026-10-24 的「同一只猫只有 9%」
就是这么来的。

素材组织（两种都支持）：
    <dir>/<猫名>/1.jpg 2.jpg ...      ← 推荐，一只猫一个子目录
    <dir>/<猫名>1.jpg <猫名>2.jpg ... ← 平铺，按「去掉结尾数字」分组

跑法（在 server/ 目录下）：
    ..\\env\\Scripts\\python.exe tools/real_sim_eval.py "E:/path/to/猫照片"
    ..\\env\\Scripts\\python.exe tools/real_sim_eval.py "E:/path/to/猫照片" --pad 0.08

输出：
  1) 每张图的检测/花色结论；
  2) 余弦矩阵 + 同猫/异猫分布（同时给出旧线性映射与新 logistic 映射的分数，
     一眼看出「同样一条余弦，改校准前后差多少」）；
  3) 留一法检索：每张照片当查询，库里放其它照片，Top1 命中率 + 展示分。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app import config, engine, main  # noqa: E402

EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def old_grade(sim: float) -> int:
    """改造前的映射（0.75~0.90 线性），只为对照。"""
    return int(max(0.0, min(99.0, round((sim - 0.75) / (0.90 - 0.75) * 100))))


def collect(root: Path) -> dict:
    """→ {猫名: [照片路径, ...]}"""
    groups: dict = {}
    for sub in sorted(p for p in root.iterdir() if p.is_dir()):
        files = sorted(f for f in sub.iterdir() if f.suffix.lower() in EXTS)
        if files:
            groups[sub.name] = files
    if groups:
        return groups
    for f in sorted(root.iterdir()):
        if f.suffix.lower() not in EXTS:
            continue
        name = re.sub(r"[\s_\-]*\d+$", "", f.stem) or f.stem
        groups.setdefault(name, []).append(f)
    return groups


def main_() -> None:
    args = [a for a in sys.argv[1:]]
    pad = None
    if "--pad" in args:
        i = args.index("--pad")
        pad = float(args[i + 1])
        del args[i:i + 2]
    root = Path(args[0] if args else ".")
    if not root.exists():
        print("目录不存在:", root)
        return

    config.REID_ONNX = config.REID_ONNX or "models/reid.onnx"
    eng = engine.get_engine()
    print("provider:", eng.provider, "dim:", eng.dim, "size:", eng.embedder.size,
          "detector:", bool(eng.detector.sess))
    if pad is not None:
        config.DETECT_PAD = pad
        print("临时覆盖 DETECT_PAD =", pad)

    groups = collect(root)
    if not groups:
        print("没找到图片:", root)
        return

    rows = []
    for name, files in groups.items():
        for p in files:
            im = Image.open(p).convert("RGB")
            emb, detected, a = eng.features_ex(im)
            rows.append({"name": name, "file": p.name, "emb": emb, "det": detected, "attr": a})
            print(f"{name:<10}{p.name:<26} 检测={'是' if detected else '否'} "
                  f"花色={a['color'] or '-'}/{a['pattern'] or '-'}"
                  f"({a['source']} {a['confidence']:.2f})"
                  f"{'  ' + a['reason'] if a['reason'] else ''}")

    n = len(rows)
    print("\n=== 余弦矩阵 ===")
    print(" " * 30 + "".join(f"{r['name'][:4]:>8}" for r in rows))
    for i, r in enumerate(rows):
        line = f"{r['name'][:10]:<12}{r['file'][:16]:<18}"
        line += "".join(f"{float(r['emb'] @ rows[j]['emb']):>8.3f}" for j in range(n))
        print(line)

    intra, inter = [], []
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            s = float(rows[i]["emb"] @ rows[j]["emb"])
            (intra if rows[i]["name"] == rows[j]["name"] else inter).append(s)
    if intra:
        lo = min(intra)
        print(f"\n同猫：min={lo:.3f} 均值={np.mean(intra):.3f}  旧分={old_grade(lo)} 新分={main.to_grade(lo)}")
    if inter:
        hi = max(inter)
        print(f"异猫：max={hi:.3f} 均值={np.mean(inter):.3f}  旧分={old_grade(hi)} 新分={main.to_grade(hi)}")
    if intra and inter:
        print(f"间隔：{min(intra) - max(inter):+.3f}"
              f"{'（重叠，任何绝对阈值都会误判其中一边）' if min(intra) <= max(inter) else ''}")

    # 留一法：每张照片当查询，库里是**其它**照片里每个体取一张
    print("\n=== 留一法检索 ===")
    orig = main.index_store.load
    try:
        for q in rows:
            bank, cats = {}, []
            for g in rows:
                if g["name"] == q["name"]:
                    continue
                if g["name"] in bank:
                    continue
                bank[g["name"]] = g["emb"]
                cats.append(main.CatRef(id=g["name"], name=g["name"],
                                        pattern=(g["attr"] or {}).get("color") or "",
                                        photos=[g["file"]]))
            # 同个体的另一张（若有）也要进库，否则「自匹配」无从谈起
            sibs = [g for g in rows if g["name"] == q["name"] and g is not q]
            if sibs:
                bank[q["name"]] = sibs[0]["emb"]
                cats.append(main.CatRef(id=q["name"], name=q["name"],
                                        pattern=(sibs[0]["attr"] or {}).get("color") or "",
                                        photos=[sibs[0]["file"]]))
            main.index_store.load = lambda sid="", b=bank: b
            cands, _ = main.search(q["emb"], cats, "", attrs=q["attr"])
            top = cands[0] if cands else None
            hit = bool(top and top["catId"] == q["name"])
            mark = "✓" if hit else ("—" if not sibs and top else "✗")
            print(f"  {mark} {q['name']:<10}{q['file']:<22}"
                  f"Top1={top['name'] if top else '无候选':<10}"
                  f"原始={top['rawSim'] * 100 if top else 0:5.1f}% "
                  f"旧分={old_grade(top['rawSim']) if top else 0:3d} "
                  f"新分={top['score'] if top else 0:3d} "
                  f"领先={top.get('lead', 0) * 100 if top else 0:4.1f}% "
                  f"{'认定' if top and top['score'] >= config.IDENTIFY_MIN else '不认定'}")
    finally:
        main.index_store.load = orig

    if intra and inter and min(intra) <= max(inter):
        print("\n⚠️ 同猫与异猫的余弦区间重叠：这种情况下**排序**才是唯一可靠信号，"
              "别指望调阈值同时救两边。要根本改善，得换更细粒度的 ReID 权重"
              "（现用 reid.onnx 的 CLS 特征，224 输入）。")


if __name__ == "__main__":
    main_()
