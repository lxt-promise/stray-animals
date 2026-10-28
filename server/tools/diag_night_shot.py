# -*- coding: utf-8 -*-
"""夜间低光照片识别诊断：拿一张真实照片跑完整链路，看每一环到底输出了什么。

用途
----
排查「白猫判成奶牛 / 候选是橘猫 83%」这类问题时，界面只给结论，
而链路有 5 个环节都可能出问题（检测框、提特征、花色判定、阈值、硬过滤），
必须逐环打印才能定位。

    ..\\env\\Scripts\\python.exe tools/diag_night_shot.py <图片路径>

会打印：
  1. 检测框（是否定位到猫、框占画面比例、是否可能把背景算进去）
  2. 属性判定全字段（color/pattern/confidence/来源/色板/未采信原因）
  3. 特征库每只猫与查询向量的原始余弦排名
  4. 同一张照片 × 不同「档案花色标注」下的硬过滤行为
     （用来验证「档案 pattern=other 时硬过滤放行」这条路径）
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app import attrs as attr_labels  # noqa: E402
from app import config, engine, index_store, main  # noqa: E402


def pct(x: float) -> str:
    return "%.1f%%" % (100.0 * float(x))


def main_diag() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--school", default="", help="特征库按校过滤，本地调试留空取全量")
    ap.add_argument("--top-n", type=int, default=5)
    args = ap.parse_args()

    p = Path(args.image)
    if not p.exists():
        print("找不到图片：%s" % p)
        return 2
    im = Image.open(p).convert("RGB")
    W, H = im.size
    print("图片 %s  %dx%d" % (p.name, W, H))

    # ---------- 1. 检测 + 提特征 + 花色 ----------
    eng = engine.get_engine()
    an = eng.analyze_frames([im])
    box, core = an["box"], an["core"]
    print("\n=== 1. 检测 ===")
    print("  定位到猫体 : %s（候选 %d 个，conf %.2f）%s"
          % (an["detected"], an["detectCandidates"], an["detectConf"], an["detectReason"]))
    if box:
        bw, bh = box[2] - box[0], box[3] - box[1]
        print("  外扩框     : %s → 占画面 %.0f%%" % (box, 100.0 * bw * bh / (W * H)))
    if core:
        cw, ch = core[2] - core[0], core[3] - core[1]
        print("  紧绷框     : %s → 占画面 %.0f%%" % (core, 100.0 * cw * ch / (W * H)))
    q = an.get("quality") or {}
    print("  质量门控   : ok=%s area=%.1f%% lightMeanV=%s %s"
          % (q.get("ok"), 100.0 * float(q.get("areaRatio") or 0),
             q.get("lightMeanV"), q.get("reason") or ""))

    a = an["attr"] or {}
    print("\n=== 2. 花色判定（confidence ≥ %.2f 才会参与硬过滤）==="
          % config.ATTR_RERANK_MIN_CONF)
    for k in ("color", "pattern", "breed", "source"):
        print("  %-12s %s" % (k, a.get(k) or "(空)"))
    print("  %-12s %.3f" % ("confidence", float(a.get("confidence") or 0)))
    pal = a.get("palette") or []
    if pal:
        top = sorted(pal, key=lambda x: -float(x.get("ratio") or 0))[:5]
        print("  %-12s %s" % ("色板", "  ".join(
            "%s %.0f%%" % (t.get("label") or t.get("bucket"), 100 * float(t.get("ratio") or 0))
            for t in top)))
    if a.get("reason"):
        print("  %-12s %s" % ("reason", a["reason"]))
    print("  → 硬过滤用的颜色 qcolor = %r"
          % (str(a.get("color") or "") if float(a.get("confidence") or 0)
             >= config.ATTR_RERANK_MIN_CONF else ""))

    # ---------- 3. 特征库排名 ----------
    query = engine.rep_vector(an["embs"])
    bank = index_store.load(args.school) or {}
    print("\n=== 3. 特征库（school=%r，%d 条）原始余弦排名 ===" % (args.school, len(bank)))
    if not bank:
        print("  （本地库为空 —— 线上库在云托管/COS，本地看不到，排名仅作参考）")
    rows = []
    for cid, vec in bank.items():
        v = np.asarray(vec, dtype=np.float32).reshape(-1)
        if v.shape[0] != query.shape[0]:
            continue
        rows.append((float(query @ v), cid))
    rows.sort(reverse=True)
    for sim, cid in rows:
        mark = " ← 超过 MIN_SIM=%.2f" % config.MIN_SIM if sim >= config.MIN_SIM else ""
        print("  %s  %s%s" % (pct(sim), cid, mark))

    # ---------- 4. 硬过滤行为矩阵 ----------
    print("\n=== 4. 硬过滤行为（查询花色=%r）===" % (a.get("color") or ""))
    qc = str(a.get("color") or "")
    if not qc:
        print("  查询花色为空 → 不过滤，任何猫都可能成为候选")
    for pat in ("orange", "calico", "tortoiseshell", "tabby", "gray", "cow",
                "tuxedo", "black", "white", "other", ""):
        blocked = attr_labels.hard_exclusive(qc, pat) if qc else False
        print("  pattern=%-14s → %s" % (pat or "(空)", "剔除" if blocked else "放行"))

    # ---------- 5. 用 search 真跑一遍（档案花色分别设成不同值） ----------
    print("\n=== 5. search() 实跑（top_n=%d）===" % args.top_n)
    if not rows:
        print("  本地无特征库，跳过")
        return 0
    ids = [cid for _, cid in rows]
    for pat in ("orange", "other", ""):
        cats = [main.CatRef(id=cid, name=cid, pattern=pat) for cid in ids]
        cands, info = main.search(query, cats, args.school, top_n=args.top_n, attrs=a)
        names = ["%s %s(%s)" % (c.get("name"), pct(c.get("score") or 0),
                                str(c.get("catId"))[:6]) for c in cands]
        print("  档案 pattern=%-8r → 候选 %d 只，attrDropped=%s：%s"
              % (pat, len(cands), info.get("attrDropped", 0), " | ".join(names) or "(无)"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main_diag())
