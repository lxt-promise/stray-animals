"""花色判定方法 A/B 评估台（2026-11-05）。

对比四种方法在**同一批素材**上的表现，回答「哪种方法适应性最好」：

  L0  现有链路：全局色桶直方图 + 硬阈值规则链（含质量门控拒识）
  L1  稳健统计：掩膜分 3×3 瓦片，剔除离群污染瓦片再汇总（ATTR_ROBUST_STATS）
  L2  证据打分 + 弃权：每类连续打分，Top1 与 Top2 边际不足时拒识（脚本内实现）
  L3  原型最近邻：统计量特征空间上留一法最近质心（脚本内实现）

三组评测：
  ① 干净集：18 张实拍 + 16 张标准照（文件名前缀即真值，奶牛/大号奶牛允许 cow/tuxedo）
  ② 模糊集：干净集全部 GaussianBlur(6) —— 期望全部被质量门拒识
  ③ 遮挡集：对若干实拍在检测框角落叠加皮肤色椭圆（模拟人手），再跑完整链路

用法（在 server/ 目录下）：
    python tools/attr_ab_eval.py
结果打印到 stdout，并写 Temp/attr_ab_eval.txt。
"""
import glob
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from app import attrs, config
from app.engine import get_engine

CAT_ROOT = r"E:\Agent\worker\东南大学-猫"
DIRS = [os.path.join(CAT_ROOT, "原图"), os.path.join(CAT_ROOT, "标准照")]

# 文件名前缀 → 真值（顺序敏感：「大号奶牛」必须先于「奶牛」）
GT = [("大号奶牛", "cow"), ("小奶牛", "cow"), ("三花", "calico"), ("奶牛", "cow"),
      ("橘猫", "orange"), ("狸花", "tabby"), ("白猫", "white"),
      ("玄猫", "black"), ("玳瑁", "tortoiseshell")]
# 允许家族：奶牛家族允许 tuxedo（黑白子类），黑猫夜拍允许 gray
FAMILY = {"cow": {"cow", "tuxedo"}, "black": {"black", "gray"}}


def truth_of(name: str):
    for pre, label in GT:
        if name.startswith(pre):
            return label
    return None


def ok_of(pred: str, truth: str) -> bool:
    return pred in FAMILY.get(truth, {truth})


# ---------------- 采集：跑真实管线，捕获每张图的 crop/mask/统计量 ----------------
def collect_samples():
    """对每张图跑 analyze_frames，并用 spy 捕获 attrs._stats_of 的真实入参。"""
    eng = get_engine()
    orig_stats = attrs._stats_of
    captured = []

    def spy(rgb, cropped, mask=None):
        st = orig_stats(rgb, cropped, mask=mask)
        captured.append({"rgb": rgb.copy(),
                         "mask": None if mask is None else np.array(mask).copy(),
                         "st": st})
        return st

    attrs._stats_of = spy
    samples = []
    try:
        for d in DIRS:
            files = sorted(glob.glob(os.path.join(d, "*.jpg"))
                           + glob.glob(os.path.join(d, "*.png")))
            for p in files:
                name = os.path.basename(p)
                truth = truth_of(name)
                if truth is None:
                    print("!! 未识别真值前缀，跳过：%s" % name)
                    continue
                captured.clear()
                im = Image.open(p).convert("RGB")
                a = eng.analyze_frames([im]).get("attr") or {}
                if not captured:
                    samples.append({"name": name, "truth": truth, "rgb": None,
                                    "mask": None, "st": None, "attr": a})
                    continue
                cap = captured[-1]
                samples.append({"name": name, "truth": truth,
                                "rgb": cap["rgb"], "mask": cap["mask"],
                                "st": cap["st"], "attr": a})
    finally:
        attrs._stats_of = orig_stats
    return samples


# ---------------- 判定 ----------------
def decide_from(st):
    if not st:
        return ""
    color, _pat = attrs._decide(st["ratio"], st["stripe"], st["dgray"],
                                st.get("warmish"), bright=st.get("bright"),
                                sat=st.get("sat"), pale=st.get("pale"))
    return color


def stats_of(sample, robust: bool):
    """用捕获的 crop/mask 重算统计量（robust=True 时开 L1）。"""
    if sample["rgb"] is None:
        return None
    old = config.ATTR_ROBUST_STATS
    config.ATTR_ROBUST_STATS = robust
    try:
        return attrs._stats_of(sample["rgb"], True, mask=sample["mask"])
    finally:
        config.ATTR_ROBUST_STATS = old


def l2_scores(st):
    """证据打分：每个花色家族一个 0~1 的连续证据分（脚本内实现，用于评估）。"""
    r = st["ratio"]
    stripe = st["stripe"]
    dgray = st["dgray"]
    warmish = st.get("warmish") or 0.0
    pale = st.get("pale") or 0.0
    light = r["white"] + max(0.0, r["gray"] - dgray)
    dark = r["black"] + dgray
    orange = r["orange"] + 0.5 * r["brown"] + r["red"]
    warm = r["orange"] + r["brown"] + r["cream"]
    tab_ev = min(1.0, stripe / 0.6)
    clean = 1.0 - min(1.0, warm / 0.35)          # 暖色越少，黑白家族越可信
    return {
        "white": light,
        "black": dark,
        "gray": r["gray"] * 0.9,
        "orange": orange * (1.0 + 0.3 * tab_ev),
        "tabby": tab_ev * max(warmish, light) + 0.15 * orange,
        "cow": 2.0 * min(light, dark) * clean,
        "calico": 2.5 * min(light, orange + pale, dark),
        "tortoiseshell": 2.0 * min(dark, warm),
    }


def l2_decide(st, margin: float):
    sc = l2_scores(st)
    top2 = sorted(sc.items(), key=lambda kv: -kv[1])[:2]
    if top2[0][1] <= 0.05:                        # 没有任何有效证据
        return ""
    if top2[0][1] - top2[1][1] < margin:          # 领先不足 → 弃权
        return ""
    return top2[0][0]


FEATURE_KEYS = ["white", "black", "gray", "orange", "brown", "cream", "red"]


def features_of(st):
    r = st["ratio"]
    dgray = st["dgray"]
    light = r["white"] + max(0.0, r["gray"] - dgray)
    dark = r["black"] + dgray
    return np.array([r[b] for b in FEATURE_KEYS] + [
        dgray, st.get("warmish") or 0.0, st.get("pale") or 0.0,
        st["stripe"], light, dark,
        st.get("bright") or 0.0, (st.get("sat") or 0.0) / 255.0,
        (st.get("vmed") or 0.0) / 255.0, (st.get("shift") or 0.0) / 255.0,
    ], dtype=np.float64)


def l3_decide_all(stats_list, truths):
    """留一法原型最近邻，返回 {i: label}。"""
    X = np.stack([features_of(st) for st in stats_list])
    ys = list(truths)
    mu, sd = X.mean(axis=0), X.std(axis=0) + 1e-9
    Z = (X - mu) / sd
    out = {}
    for i in range(len(Z)):
        d2 = ((Z - Z[i]) ** 2).sum(axis=1)
        d2[i] = np.inf
        out[i] = ys[int(np.argmin(d2))]
    return out


# ---------------- 扰动集 ----------------
def blur_eval(eng):
    """干净集全部 GaussianBlur(6)，按端到端口径统计拒识。

    端到端 = attrs 质量门拒识（attr.refused）**或**查询质量门拒识
    （quality.ok=False，例如糊到检测不到猫体 → main.py 会花色弃权 + 不检索）。
    """
    refused, total = 0, 0
    for d in DIRS:
        for p in sorted(glob.glob(os.path.join(d, "*.jpg"))
                        + glob.glob(os.path.join(d, "*.png"))):
            if truth_of(os.path.basename(p)) is None:
                continue
            im = Image.open(p).convert("RGB").filter(ImageFilter.GaussianBlur(6))
            res = eng.analyze_frames([im])
            a = res.get("attr") or {}
            q = res.get("quality") or {}
            total += 1
            refused += 1 if (a.get("refused") or not q.get("ok", True)) else 0
    return refused, total


def occluded_image(eng, im):
    """在检测框一角叠加皮肤色椭圆（模拟人手），返回新图。"""
    det = eng.detector.detect(im) if getattr(eng, "detector", None) else {}
    box = det.get("box")
    if not box:
        return None
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    out = im.copy()
    dr = ImageDraw.Draw(out)
    rx, ry = int(w * 0.30), int(h * 0.35)
    dr.ellipse([x1, y1 + h - 2 * ry, x1 + 2 * rx, y1 + h], fill=(215, 170, 135))
    arr = np.asarray(out).astype(np.int16)
    noise = np.random.default_rng(7).integers(-8, 9, size=arr.shape, dtype=np.int16)
    return Image.fromarray(np.clip(arr + noise, 0, 255).astype(np.uint8))


def occlusion_eval(eng, samples):
    """对每类各取 1~2 张做皮肤遮挡，比较 robust 开/关的判定。"""
    picked, seen = [], set()
    for s in samples:
        if s["rgb"] is None or s["name"].endswith(".png"):
            continue
        if s["truth"] in seen:
            continue
        seen.add(s["truth"])
        picked.append(s)
        if len(picked) >= 8:
            break
    rows = []
    for s in picked:
        path = None
        for d in DIRS:
            cand = os.path.join(d, s["name"])
            if os.path.exists(cand):
                path = cand
        if path is None:
            continue
        im = Image.open(path).convert("RGB")
        occ = occluded_image(eng, im)
        if occ is None:
            continue
        labels = {}
        for robust in (False, True):
            old = config.ATTR_ROBUST_STATS
            config.ATTR_ROBUST_STATS = robust
            try:
                a = eng.analyze_frames([occ]).get("attr") or {}
            finally:
                config.ATTR_ROBUST_STATS = old
            labels[robust] = a.get("color") or ("<%s>" % (a.get("reason") or "?"))[:12]
        rows.append((s["name"], s["truth"], labels[False], labels[True]))
    return rows


# ---------------- 汇总 ----------------
def report(samples, l0_pred, l1_pred, l2_preds, l3_pred):
    lines = []
    header = "%-30s %-5s | %-5s %-5s | %-8s %-8s %-8s | %-5s" % (
        "图片", "真值", "L0", "L1", "L2@0", "L2@0.08", "L2@0.15", "L3")
    lines.append(header)
    lines.append("-" * len(header))
    for i, s in enumerate(samples):
        lines.append("%-30s %-5s | %-5s %-5s | %-8s %-8s %-8s | %-5s" % (
            s["name"][:30], s["truth"], l0_pred[i], l1_pred[i],
            l2_preds[0.0][i], l2_preds[0.08][i], l2_preds[0.15][i], l3_pred[i]))
    lines.append("")
    for label, preds in [("L0", l0_pred), ("L1", l1_pred),
                         ("L2@0", l2_preds[0.0]), ("L2@0.08", l2_preds[0.08]),
                         ("L2@0.15", l2_preds[0.15]), ("L3", l3_pred)]:
        decided = [i for i, p in enumerate(preds) if p]
        correct = [i for i in decided if ok_of(preds[i], samples[i]["truth"])]
        refused = len(samples) - len(decided)
        lines.append("%-8s 判对 %2d / 给结论 %2d / 拒识 %2d / 共 %d" % (
            label, len(correct), len(decided), refused, len(samples)))
    return lines


def main():
    eng = get_engine()
    samples = collect_samples()
    print("样本 %d 张" % len(samples))

    l0_pred, l1_pred = [], []
    for s in samples:
        st0 = stats_of(s, False)
        st1 = stats_of(s, True)
        l0_pred.append(decide_from(st0))
        l1_pred.append(decide_from(st1))
        if st0 and st1 and st1.get("robustDropped"):
            print("  L1 剔瓦片 %s: %d 块, warmish %.3f→%.3f" % (
                s["name"], st1["robustDropped"],
                st0.get("warmish") or 0, st1.get("warmish") or 0))

    l2_preds = {m: [l2_decide(stats_of(s, False), m) if stats_of(s, False) else ""
                    for s in samples] for m in (0.0, 0.08, 0.15)}
    stats0 = [stats_of(s, False) for s in samples]
    l3_map = l3_decide_all(stats0, [s["truth"] for s in samples])
    l3_list = [l3_map[i] for i in range(len(samples))]

    lines = report(samples, l0_pred, l1_pred, l2_preds, l3_list)

    refused, total = blur_eval(eng)
    lines.append("")
    lines.append("模糊集（GaussianBlur 6）：拒识 %d / %d（期望全拒）" % (refused, total))

    lines.append("")
    lines.append("遮挡集（皮肤色椭圆叠加，L0 vs L1）：")
    for name, truth, l0, l1 in occlusion_eval(eng, samples):
        lines.append("  %-28s 真值=%-12s L0=%-14s L1=%-14s" % (name, truth, l0, l1))

    out = "\n".join(lines)
    print(out)
    path = os.path.join(tempfile.gettempdir(), "attr_ab_eval.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    print("\n已写入 %s" % path)


if __name__ == "__main__":
    main()
