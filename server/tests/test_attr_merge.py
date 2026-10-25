# -*- coding: utf-8 -*-
"""多帧属性聚合（attrs.merge_and_decide）的行为测试。

背景：「没匹配到猫时展示的花色」此前取「置信度最高的单帧」，糊帧/逆光帧
照样能给出高置信错误结论。聚合器把各帧中间统计量加权平均后统一判定，
各帧独立结论的一致率折进置信度、分歧写进 reason。这里锁的就是这套行为。
"""
import unittest

from app import attrs


def frame(color, pattern, conf, ratio=None, dgray=0.1, stripe=0.2, coverage=0.9):
    """构造一个「帧结果」：分析结论 + 内部统计量（_stats）。"""
    ratio = ratio or {"white": 0.3, "black": 0.3, "gray": 0.2, "orange": 0.1,
                      "brown": 0.0, "cream": 0.0, "red": 0.0, "other": 0.0}
    return {
        "color": color, "pattern": pattern, "breed": attrs._breed_of(color, pattern),
        "confidence": conf, "source": "heuristic", "palette": [], "stripe": stripe,
        "reason": "" if color else "颜色不集中",
        "_stats": {"ratio": ratio, "dgray": dgray, "stripe": stripe,
                   "coverage": coverage, "shift": 0.0},
    }


class TestMergeAndDecide(unittest.TestCase):
    def test_no_heuristic_frames_returns_none(self):
        """全是 CLIP 帧（无 _stats）→ 返回 None，调用方退回「最佳单帧」旧行为。"""
        clip = {"color": "cow", "pattern": "cow", "confidence": 0.8,
                "source": "clip", "reason": ""}
        self.assertIsNone(attrs.merge_and_decide([clip, clip]))

    def test_single_frame_equivalent(self):
        """单帧：聚合应与直接判定一致（置信度不打折，agreement=1）。"""
        f = frame("cow", "cow", 0.7)
        out = attrs.merge_and_decide([f])
        self.assertIsNotNone(out)
        self.assertEqual(out["color"], "cow")
        # 置信度公式本身可能不同于原帧（重新按色板算），但一致性不打折时
        # 应等于 _confidence_of(ratio, 1.0)
        self.assertEqual(out["confidence"], attrs._confidence_of(f["_stats"]["ratio"], 1.0))
        self.assertEqual(out.get("frames"), 1)

    def test_frames_with_no_conclusion_all_fail(self):
        """所有帧都判不出（都带 reason，被聚合器过滤）→ 返回 None，
        由调用方退回「最佳单帧 / 空结果」逻辑。"""
        out = attrs.merge_and_decide([frame("", "", 0.0), frame("", "", 0.0)])
        self.assertIsNone(out)

    def test_fallback_to_best_frame_when_merged_blank(self):
        """色板平均后判不出、但有单帧结论 → 取最高置信单帧 + 「仅供参考」。"""
        # 所有色桶占比都太低（top<0.16）→ _decide 返回空；单帧却给了结论
        even = {"white": 0.10, "black": 0.10, "gray": 0.10, "orange": 0.10,
                "brown": 0.08, "cream": 0.08, "red": 0.0, "other": 0.44}
        f1 = frame("cow", "cow", 0.6, ratio=even, dgray=0.0)
        f2 = frame("cow", "cow", 0.4, ratio=even, dgray=0.0)
        out = attrs.merge_and_decide([f1, f2])
        self.assertEqual(out["color"], "cow")
        self.assertIn("仅供参考", out["reason"])

    def test_confidence_discounted_by_disagreement(self):
        """多数票一致率折进置信度：全票一致不打折，对半分歧显著打折。"""
        cow = frame("cow", "cow", 0.7)
        agree = attrs.merge_and_decide([cow, cow, cow, cow])
        disagree = attrs.merge_and_decide([cow, cow, frame("tabby", "tabby", 0.7),
                                           frame("tabby", "tabby", 0.7)])
        self.assertIsNotNone(agree)
        self.assertIsNotNone(disagree)
        self.assertGreater(agree["confidence"], disagree["confidence"])
        self.assertLessEqual(disagree["confidence"], 0.62)

    def test_disagreement_written_to_reason(self):
        """聚合结论与多数票打架时，分歧必须写进 reason（不许静默）。"""
        # cow 帧多（2:1）但 tabby 帧覆盖率压倒性高 → 色板聚合应判 tabby
        cowish = {"white": 0.25, "black": 0.25, "gray": 0.1, "orange": 0.02,
                  "brown": 0.0, "cream": 0.0, "red": 0.0, "other": 0.38}
        tabbyish = {"white": 0.05, "black": 0.2, "gray": 0.3, "orange": 0.05,
                    "brown": 0.05, "cream": 0.05, "red": 0.0, "other": 0.3}
        cow_f = frame("cow", "cow", 0.7, ratio=cowish, coverage=0.05, stripe=0.95)
        tab_f = frame("tabby", "tabby", 0.9, ratio=tabbyish, stripe=0.95, coverage=0.95)
        out = attrs.merge_and_decide([cow_f, cow_f, tab_f])
        self.assertIsNotNone(out)
        self.assertEqual(out["color"], "tabby")     # 覆盖率加权让清晰帧主导
        self.assertIn("不一致", out["reason"])       # 多数票是 cow，必须写出分歧

    def test_merge_stats_weights_by_coverage(self):
        """色板聚合按覆盖率加权：糊帧（coverage 低）影响小。"""
        crisp = {"white": 0.0, "black": 0.0, "gray": 0.0, "orange": 0.6,
                 "brown": 0.0, "cream": 0.0, "red": 0.0, "other": 0.4}
        blurry = {"white": 0.0, "black": 0.0, "gray": 0.6, "orange": 0.0,
                  "brown": 0.0, "cream": 0.0, "red": 0.0, "other": 0.4}
        m = attrs.merge_stats([
            {"ratio": crisp, "dgray": 0.0, "stripe": 0.1, "coverage": 0.95, "shift": 0.0},
            {"ratio": blurry, "dgray": 0.0, "stripe": 0.1, "coverage": 0.05, "shift": 0.0},
        ])
        self.assertGreater(m["ratio"]["orange"], 0.5)   # 清晰橘帧应主导
        self.assertLess(m["ratio"]["gray"], 0.1)

    def test_merge_stats_stripe_median(self):
        """stripe 取中位数：离群高值（假边缘帧）不拖走整体。"""
        base = {"white": 0.0, "black": 0.0, "gray": 0.0, "orange": 0.6,
                "brown": 0.0, "cream": 0.0, "red": 0.0, "other": 0.4}
        m = attrs.merge_stats([
            {"ratio": base, "dgray": 0, "stripe": 0.2, "coverage": 0.9, "shift": 0},
            {"ratio": base, "dgray": 0, "stripe": 0.2, "coverage": 0.9, "shift": 0},
            {"ratio": base, "dgray": 0, "stripe": 0.98, "coverage": 0.9, "shift": 0},
        ])
        self.assertEqual(m["stripe"], 0.2)

    def test_exposure_gain_zero_disables_shift(self):
        """守门（行为级）：ATTR_EXPOSURE_GAIN=0 必须真的关闭自适应 ——
        禁止 `x or 默认值` 的取值写法，它会把合法的 0 顶成 0.6（项目踩过多次）。"""
        import numpy as np
        from app import config
        v = np.full((32, 32), 100.0, dtype=np.float32)
        w = np.ones((32, 32), dtype=np.float64)
        old = config.ATTR_EXPOSURE_GAIN
        try:
            config.ATTR_EXPOSURE_GAIN = 0
            self.assertEqual(attrs._exposure_shift(v, w), 0.0)
            config.ATTR_EXPOSURE_GAIN = 0.6
            self.assertNotEqual(attrs._exposure_shift(v, w), 0.0)
        finally:
            config.ATTR_EXPOSURE_GAIN = old


if __name__ == "__main__":
    unittest.main()
