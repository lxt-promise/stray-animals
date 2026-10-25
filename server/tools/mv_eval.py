# -*- coding: utf-8 -*-
"""「一只猫存几个特征向量」实测台：单代表向量 vs 多向量。

问题
----
现在 index_store 的键是 cat_id，一只猫**只有一条**向量：档案里 5 张照片各自
提特征后由 engine.rep_vector 聚成一条（medoid + 内点平均）。
直觉上「多存几条、检索时取最像的那条」应该更准 —— 因为现场照片可能只跟
档案里的某一张（同一角度 / 同一光线）长得像，跟平均脸反而不像。

但这个直觉有个反作用力：max 算子会**同时抬高所有猫的分数**，包括错的猫。
一只猫存 5 条，等于给错猫发了 5 次「蒙对」的机会。所以必须实测，不能拍脑袋。

协议（关键设计）
----------------
把每只猫的 6 个变体切成两组，绝不让查询图出现在库里：
    ENROLL  = orig / grass / wood     —— 当作「档案照」，用来建库
    QUERY   = bright / dim / blur     —— 当作「现场照」，只用来检索
这样比出来的才是**泛化能力**。若允许查询图进库，多向量必然赢（等于背答案），
测出来的全是假象。

对比方法
--------
    S-rep   单向量：rep_vector 聚合（**当前线上实现**）
    S-mean  单向量：直接平均（看 medoid 筛选到底有没有用）
    S-first 单向量：只留第一张（对照：档案照数量 = 1）
    M-max   多向量：逐条比对取最大余弦
    M-top2  多向量：取前 2 条求平均
    M-mean  多向量：全部求平均

指标
----
    top1    检索首命中率（最贴近用户感知）
    margin  正确猫分数 - 最像的错误猫分数（越大越不容易被阈值卡住 / 被花色过滤误杀）
    auc     随机一对（正确猫分, 错误猫分），正确更高的概率
    fpr     错误猫分数超过 MIN_SIM 的比例 —— 多向量抬高错猫分的代价，必须盯

用法
----
    ..\\env\\Scripts\\python.exe tools/mv_eval.py
    ..\\env\\Scripts\\python.exe tools/mv_eval.py --enroll 2     # 档案照只留 2 张
    ..\\env\\Scripts\\python.exe tools/mv_eval.py --no-detect     # 关检测做对照
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

# 分组必须与 ab_eval 的变体一致，保证两次评测口径对齐
ENROLL_VIEWS = ["orig", "grass", "wood"]
QUERY_VIEWS = ["bright", "dim", "blur", "zoom", "shift", "rot12", "flip"]


def grid_cats() -> dict:
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


def probe_cats() -> dict:
    """data/probe 下的真实猫照（黑 / 白 / 橘），文件名即标签。"""
    out = {}
    d = DATA / "probe"
    if not d.exists():
        return out
    for p in sorted(d.glob("*.png")):
        out["probe_" + p.stem[:24]] = Image.open(p).convert("RGB")
    return out


def on_bg(im: Image.Image, color: tuple, scale: float = 0.82) -> Image.Image:
    w, h = im.size
    nw, nh = int(w * scale), int(h * scale)
    bg = Image.new("RGB", (w, h), color)
    bg.paste(im.resize((nw, nh), Image.BILINEAR), ((w - nw) // 2, (h - nh) // 2))
    return bg


def variants(im: Image.Image) -> dict:
    """10 个变体：3 张建档 + 7 张查询。

    ⚠️ 只用亮度/背景扰动是测不出差异的 —— 检测框把猫抠出来、再 letterbox 归一，
    亮度和背景基本被吃掉了（实测 6 种方法全 100%、margin 一模一样）。
    真正让 ReID 向量漂移的是**取景**：猫占画面多大、歪没歪、朝哪边，
    因为检测框的位置/尺度和裁剪内容都变了。所以查询侧全部用几何扰动。
    """
    w, h = im.size
    zoom = im.crop((int(w * 0.15), int(h * 0.15),
                    int(w * 0.85), int(h * 0.85))).resize((w, h), Image.BILINEAR)
    shift = im.crop((int(w * 0.12), 0, w, int(h * 0.88))).resize((w, h), Image.BILINEAR)
    rot = im.rotate(12, resample=Image.BICUBIC, fillcolor=(128, 128, 128))
    zoom50 = im.crop((int(w * 0.25), int(h * 0.25),
                      int(w * 0.75), int(h * 0.75))).resize((w, h), Image.BILINEAR)
    rot25 = im.rotate(25, resample=Image.BICUBIC, fillcolor=(128, 128, 128))
    return {
        "orig": im,
        "grass": on_bg(im, (74, 118, 62)),
        "wood": on_bg(im, (150, 106, 68)),
        "bright": ImageEnhance.Brightness(im).enhance(1.3),
        "dim": ImageEnhance.Brightness(im).enhance(0.7),
        "blur": im.filter(ImageFilter.GaussianBlur(1.4)),
        "zoom": zoom,
        "shift": shift,
        "rot12": rot,
        "flip": im.transpose(Image.FLIP_LEFT_RIGHT),
        "zoom50": zoom50,
        "rot25": rot25,
    }


def auc_of(pairs: list) -> float:
    """pairs = [(正确分, 最像的错猫分)]，返回正例压过负例的概率。"""
    if not pairs:
        return float("nan")
    pos = np.asarray([p[0] for p in pairs], dtype=np.float64)
    neg = np.asarray([p[1] for p in pairs], dtype=np.float64)
    return float(((pos > neg).sum() + 0.5 * (pos == neg).sum()) / pos.size)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--enroll", type=int, default=3,
                    help="每只猫用几张档案照建库（1~3）")
    ap.add_argument("--enroll-set", choices=["easy", "div", "extreme"], default="div",
                    help="easy=三张近似重复（orig/grass/wood）；"
                         "div=三张取景不同（orig/zoom/shift）；"
                         "extreme=极端差异（orig/zoom50/rot25）")
    ap.add_argument("--poison", type=int, default=0,
                    help="每只猫的档案里混进 N 张「拍错的」照片（别猫的图），"
                         "看单向量的离群剔除能不能扛住")
    ap.add_argument("--no-detect", action="store_true", help="关闭检测（整图提特征）")
    args = ap.parse_args()

    if args.no_detect:
        config.DETECT_AUTO = False
    config.REID_ONNX = config.REID_ONNX or "models/reid.onnx"
    eng = engine.get_engine()
    print("provider=%s dim=%s detector=%s  enroll=%d"
          % (eng.provider, eng.dim, bool(eng.detector.sess), args.enroll))

    cats = dict(grid_cats())
    cats.update(probe_cats())
    if not cats:
        print("缺少素材")
        return
    print("猫 %d 只，每只 %d 变体（建档 %s / 查询 %s）"
          % (len(cats), len(ENROLL_VIEWS) + len(QUERY_VIEWS),
             "+".join(ENROLL_VIEWS), "+".join(QUERY_VIEWS)))

    # ---- 提特征 ----
    embs = {}      # cat -> {view: emb}
    det_hit = 0
    det_all = 0
    for name, base in cats.items():
        embs[name] = {}
        for vname, im in variants(base).items():
            e, detected, _a = eng.features_ex(im)
            embs[name][vname] = e
            det_all += 1
            det_hit += 1 if detected else 0
    print("检测命中率 = %.0f%%（%d/%d）\n" % (100.0 * det_hit / det_all, det_hit, det_all))

    # 档案照的构成：easy = 三张近乎重复（检测框吃掉背景差异）；
    # div = 大头特写 / 远景全身 / 偏移取景，这才是真实档案的样子
    # ⚠️ 建档集里**绝不能出现 orig**：所有查询变体都由 orig 派生，
    # orig 天然最像查询图，谁拿到 orig 谁白赢（实测 S-first 三场景全第一，
    # 就是这么来的）。所以 orig 只做查询图，建档集一律用扰动视图。
    pool = {
        "easy": ["grass", "wood", "bright"],
        "div": ["grass", "wood", "zoom"],
        "extreme": ["dim", "zoom50", "rot25"],
    }[args.enroll_set]
    enroll_v = pool[:max(1, min(3, args.enroll))]
    query_v = ["orig"] + [v for v in QUERY_VIEWS if v not in enroll_v]
    cat_names = list(embs.keys())
    print("建档视图 = %s\n查询视图 = %s" % ("+".join(enroll_v), "+".join(query_v)))

    # 库内离散度：同一只猫的档案照彼此有多像。
    # 这个值越接近 1，说明多向量是**冗余**的（存 3 条等于存 1 条）；
    # 越低说明确实有互补信息，多向量才有理论收益。
    spreads = []
    for c in cat_names:
        vs = [embs[c][v] for v in enroll_v]
        for i in range(len(vs)):
            for j in range(i + 1, len(vs)):
                spreads.append(float(vs[i] @ vs[j]))
    print("库内离散度：同猫档案照两两余弦 min=%.3f 均值=%.3f\n"
          % (min(spreads), float(np.mean(spreads))))

    # ---- 建库 ----
    bank_single = {}   # cat -> 单条向量（不同聚合策略）
    bank_multi = {}    # cat -> [多条向量]
    n_poison = max(0, min(2, args.poison))
    for idx, c in enumerate(cat_names):
        views = [embs[c][v] for v in enroll_v]
        if n_poison:
            # 混进别猫的照片：模拟「建档时多传了一张拍到隔壁猫的图」。
            # 单向量靠 rep_vector 的离群剔除扛，多向量则是每条都留着当门面。
            for k in range(n_poison):
                donor = cat_names[(idx + 1 + k) % len(cat_names)]
                views.append(embs[donor]["orig"])
        bank_multi[c] = views
        # S-medoid：只留 medoid 本身，不做内点平均。
        # S-adapt：视图聚得紧（均值>=0.88）就平均降噪；散得开就只用 medoid，
        #         避免「大头特写 + 远景全身」平均出一个谁都不像的中间脸。
        mat = np.stack([v / (np.linalg.norm(v) or 1.0) for v in views])
        sim = mat @ mat.T
        ss = sim.copy()
        np.fill_diagonal(ss, 0.0)
        med = int(np.argmax(ss.sum(axis=1)))
        spread = float((sim.sum() - len(views)) / max(1, len(views) * (len(views) - 1)))
        bank_single[c] = {
            "S-rep": engine.rep_vector(views),
            "S-mean": engine.rep_vector(views, keep=1.0),
            "S-first": views[0],
            "S-medoid": mat[med],
            "S-adapt": (engine.rep_vector(views) if spread >= 0.88 else mat[med]),
        }
    if n_poison:
        print("污染：每只猫档案里混了 %d 张别猫照片（库内每条 %d 向量）\n"
              % (n_poison, len(enroll_v) + n_poison))

    # ---- 检索 ----
    def score_single(qv, cat, method) -> float:
        return float(qv @ bank_single[cat][method])

    def score_multi(qv, cat, mode) -> float:
        # ⚠️ mode 由调用方 split("-") 后传入，是 "max"/"top2"/"mean"，
        # 不带 "M-" 前缀（写成 "M-max" 会静默全落到 mean 分支，三种策略数值一样）
        sims = sorted((float(qv @ v) for v in bank_multi[cat]), reverse=True)
        if mode == "max":
            return sims[0]
        if mode == "top2":
            return float(np.mean(sims[:2])) if len(sims) >= 2 else sims[0]
        return float(np.mean(sims))   # mean

    methods = ["S-rep", "S-mean", "S-first", "S-medoid", "S-adapt",
               "M-max", "M-top2", "M-mean"]
    print("%-8s %6s %8s %7s %7s %7s" % ("方法", "top1", "margin", "auc", "err>阈", "库向量"))
    print("-" * 52)
    results = {}
    for m in methods:
        pairs, top1, wrong_hi = [], 0, 0
        for qcat in cat_names:
            for vname in query_v:
                qv = embs[qcat][vname]
                sc = {}
                for c in cat_names:
                    sc[c] = (score_single(qv, c, m) if m.startswith("S")
                             else score_multi(qv, c, m.split("-", 1)[1]))
                best = max(sc.items(), key=lambda kv: kv[1])
                corr = sc[qcat]
                # 排除正确猫后最像的错猫
                wrong = max(v for k, v in sc.items() if k != qcat)
                pairs.append((corr, wrong))
                if best[0] == qcat:
                    top1 += 1
                if wrong >= config.MIN_SIM:
                    wrong_hi += 1
        n = len(pairs)
        margin = float(np.mean([p[0] - p[1] for p in pairs]))
        results[m] = {
            "top1": top1 / n, "margin": margin, "auc": auc_of(pairs),
            "fpr": wrong_hi / n, "n": n,
            "vecs": 1 if m.startswith("S") else len(enroll_v),
        }
        print("%-8s %5.0f%% %+8.4f %7.4f %6.0f%% %7d"
              % (m, 100.0 * top1 / n, margin, auc_of(pairs),
                 100.0 * wrong_hi / n, results[m]["vecs"]))

    # ---- 分查询场景看：哪种现场照最伤 ----
    print("\n=== 分查询场景 top1（列=现场照类型）===")
    print("%-8s %s" % ("方法", " ".join("%6s" % v[:6] for v in query_v)))
    for m in methods:
        cells = []
        for vname in query_v:
            hit = 0
            for qcat in cat_names:
                qv = embs[qcat][vname]
                sc = {c: (score_single(qv, c, m) if m.startswith("S")
                          else score_multi(qv, c, m.split("-", 1)[1]))
                      for c in cat_names}
                hit += 1 if max(sc.items(), key=lambda kv: kv[1])[0] == qcat else 0
            cells.append("%5.0f%%" % (100.0 * hit / len(cat_names)))
        print("%-8s %s" % (m, " ".join(cells)))

    # ---- 分数分布：多向量到底抬高了谁 ----
    print("\n=== 分数分布（正确猫 / 最像的错猫）===")
    print("%-8s %19s %19s" % ("方法", "正确  min/均值", "错猫  max/均值"))
    for m in methods:
        corr, wrong = [], []
        for qcat in cat_names:
            for vname in query_v:
                qv = embs[qcat][vname]
                sc = {c: (score_single(qv, c, m) if m.startswith("S")
                          else score_multi(qv, c, m.split("-", 1)[1]))
                      for c in cat_names}
                corr.append(sc[qcat])
                wrong.append(max(v for k, v in sc.items() if k != qcat))
        print("%-8s %9.3f/%.3f %9.3f/%.3f"
              % (m, min(corr), float(np.mean(corr)), max(wrong), float(np.mean(wrong))))

    print("\n结论口径：top1 是用户感知；margin 决定阈值/花色过滤还有多少余量；"
          "err>阈 = 错猫分数越过 MIN_SIM(%.2f) 的比例，涨了就是多向量的代价。"
          % config.MIN_SIM)


if __name__ == "__main__":
    main()
