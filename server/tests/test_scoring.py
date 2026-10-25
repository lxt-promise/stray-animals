# -*- coding: utf-8 -*-
"""相似度校准 / 花色重排 / 代表向量 的回归测试。

这一组锁的是 2026-10-24 那次「同一只猫只有 9%」的故障链路：
    原始余弦 0.763（排序正确）→ 老线性窗口压成 9 分 → 低于 identifyMin(50)
    → 界面判定「没认出来」 + 用户以为识别坏了。
三个环节各自都**不会报错**，只会给出一个看起来正常的低分，所以只能靠断言守住：

  1. to_grade  —— logistic 校准的锚点、单调性、NaN 不炸；
  2. search    —— 花色补偿只微调名次（±0.03 余弦量级）、rawSim 必须是纯余弦、
                  拉开差距时的折算地板不能砍半；
  3. rep_vector—— 多照片合成代表向量时离群视图必须被丢掉。
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from app import attrs, config, engine, main  # noqa: E402


def _unit(*vals) -> np.ndarray:
    v = np.asarray(vals, dtype=np.float32)
    return v / np.linalg.norm(v)


class TestToGrade(unittest.TestCase):
    """展示分校准。"""

    def test_anchors(self):
        """锚点：现场那组真实数字必须落在「能认出来」的区间。"""
        self.assertEqual(main.to_grade(0.763), 55)      # 用户现场：同一只猫
        self.assertGreaterEqual(main.to_grade(0.763), config.IDENTIFY_MIN)
        self.assertEqual(main.to_grade(0.698), 15)      # 现场次名（另一只猫）
        # 无关图（0.51~0.55）必须几乎归零，否则界面上会冒出「0.5 相似但 40 分」
        self.assertLessEqual(main.to_grade(0.55), 3)

    def test_monotone(self):
        """单调性是硬约束：更像的绝不能排在后面。"""
        prev = -1
        for i in range(0, 101):
            s = 0.5 + i * 0.005
            cur = main.to_grade(s)
            self.assertGreaterEqual(cur, prev, "%.3f 处出现回落" % s)
            prev = cur

    def test_bounds_and_cap(self):
        self.assertEqual(main.to_grade(1.0), config.SCORE_CAP)
        self.assertEqual(main.to_grade(0.0), 0)
        self.assertEqual(main.to_grade(-5.0), 0)
        self.assertEqual(main.to_grade(50.0), config.SCORE_CAP)   # 脏向量也不会越界

    def test_non_finite(self):
        """NaN/inf 是 truthy，max/min 都拦不住 —— 不拦会 500。"""
        for bad in (float("nan"), float("inf"), float("-inf")):
            self.assertEqual(main.to_grade(bad), 0)

    def test_identify_min_matches_curve(self):
        """IDENTIFY_MIN 与曲线必须配套：它对应一个「同猫下沿」附近的余弦。"""
        # 反推：使 to_grade 恰好等于 IDENTIFY_MIN 的余弦
        lo, hi = 0.5, 1.0
        for _ in range(40):
            mid = (lo + hi) / 2
            if main.to_grade(mid) < config.IDENTIFY_MIN:
                lo = mid
            else:
                hi = mid
        self.assertTrue(0.72 <= hi <= 0.78, "识别门槛落在 %.3f，不在同猫下沿" % hi)


class TestAttrCompatible(unittest.TestCase):
    """花色三态兼容。"""

    def test_same(self):
        self.assertIs(attrs.compatible("orange", "orange"), True)

    def test_family(self):
        """橘猫 ↔ 狸花、奶牛 ↔ 燕尾服/纯黑：色域上本来就分不开。"""
        self.assertIs(attrs.compatible("orange", "tabby"), True)
        self.assertIs(attrs.compatible("cow", "tuxedo"), True)
        self.assertIs(attrs.compatible("calico", "tortoiseshell"), True)

    def test_conflict(self):
        self.assertIs(attrs.compatible("orange", "cow"), False)
        self.assertIs(attrs.compatible("white", "black"), False)

    def test_unknown_is_none(self):
        """没填 / other / 未知取值 → None（既不是冲突也不是一致）。"""
        for a, b in (("", "orange"), ("orange", ""), ("other", "orange"),
                     ("orange", "other"), ("nonsense", "orange")):
            self.assertIsNone(attrs.compatible(a, b), "%r vs %r" % (a, b))

    def test_symmetric(self):
        for a in attrs.COLOR_LABELS:
            for b in attrs.COLOR_LABELS:
                self.assertEqual(attrs.compatible(a, b), attrs.compatible(b, a),
                                 "%s/%s 不对称" % (a, b))


class TestRepVector(unittest.TestCase):
    """多照片 → 代表向量。"""

    def test_single(self):
        v = _unit(1, 0, 0)
        out = engine.rep_vector([v])
        self.assertAlmostEqual(float(np.linalg.norm(out)), 1.0, places=5)
        self.assertAlmostEqual(float(out @ v), 1.0, places=5)

    def test_two_keeps_both(self):
        a, b = _unit(1, 0, 0), _unit(0, 1, 0)
        out = engine.rep_vector([a, b])
        # 两条不做离群判定（分不出谁是离群点），等价于平均
        self.assertAlmostEqual(float(out @ engine.l2(a + b)), 1.0, places=5)

    def test_outlier_dropped(self):
        """4 条里 3 条相近、1 条跑偏 → 代表向量不能被那条拽走。"""
        near = [_unit(1, 0.02 * i, 0) for i in range(3)]
        far = _unit(0, 1, 0)
        out = engine.rep_vector(near + [far], keep=0.7)
        mean_all = engine.l2(np.mean(np.stack(near + [far]), axis=0))
        self.assertGreater(float(out @ near[0]), float(mean_all @ near[0]) + 0.01,
                           "离群视图没有被抑制")

    def test_keep_one_is_plain_mean(self):
        vs = [_unit(1, 0, 0), _unit(0, 1, 0), _unit(0, 0, 1)]
        out = engine.rep_vector(vs, keep=1.0)
        self.assertAlmostEqual(float(out @ engine.l2(np.mean(np.stack(vs), axis=0))), 1.0, places=5)

    def test_empty_raises(self):
        with self.assertRaises(RuntimeError):
            engine.rep_vector([])

    def test_spread_out_falls_back_to_medoid(self):
        """视图彼此散得开（离散度 < REP_SPREAD_MIN）→ 退回 medoid，不平均。

        档案照是「大头特写 + 远景全身 + 侧身」时，平均出来的中间脸谁都不像
        （实测 margin +0.142 vs medoid +0.148）。见 tools/mv_eval.py。
        """
        a = _unit(1, 0, 0)
        b = _unit(0, 1, 0)
        c = _unit(0, 0, 1)          # 三条两两正交 → 离散度 ≈ 0
        out = engine.rep_vector([a, b, c])
        # 三条互为等价（离散度全同），medoid 取到谁都行，但必须是「某一条本身」
        self.assertTrue(any(abs(float(out @ v)) > 0.999 for v in (a, b, c)),
                        "离散度低时应退回 medoid 本身，而不是平均")
        mean_all = engine.l2(np.mean(np.stack([a, b, c]), axis=0))
        self.assertLess(float(abs(out @ mean_all)), 0.999,
                        "退化成了平均，没走 medoid 分支")

    def test_tight_views_still_average(self):
        """视图彼此很像（离散度 >= REP_SPREAD_MIN）→ 保持内点平均（降噪）。

        这个方向不能因为加了 medoid 分支就被破坏：档案照整齐时平均是增益。
        """
        import math as _m
        # 三条只差 5°：两两余弦 ≈ cos(5°) ≈ 0.996 > 0.88
        vs = [_unit(_m.cos(_m.radians(d)), _m.sin(_m.radians(d)), 0)
              for d in (0.0, 5.0, -5.0)]
        out = engine.rep_vector(vs)
        mid = engine.l2(np.mean(np.stack(vs), axis=0))
        self.assertGreater(float(out @ mid), 0.999,
                           "视图整齐时应走平均分支（降噪），不是 medoid")

    def test_explicit_keep_bypasses_spread(self):
        """显式传 keep 表示调用方要指定行为，不能被自适应规则改写。"""
        vs = [_unit(1, 0, 0), _unit(0, 1, 0), _unit(0, 0, 1)]
        out = engine.rep_vector(vs, keep=1.0)
        self.assertAlmostEqual(
            float(out @ engine.l2(np.mean(np.stack(vs), axis=0))), 1.0, places=5)

    def test_config_has_spread_min(self):
        """REP_SPREAD_MIN 必须真的存在于 config，别让代码引用一个不存在的名字。"""
        self.assertTrue(hasattr(config, "REP_SPREAD_MIN"),
                        "config 缺少 REP_SPREAD_MIN")
        self.assertGreater(float(config.REP_SPREAD_MIN), 0.5)
        self.assertLess(float(config.REP_SPREAD_MIN), 1.0)


class TestSearch(unittest.TestCase):
    """检索打分。用假特征库直接塞向量，不依赖 sqlite/COS。"""

    def setUp(self):
        self._orig_load = main.index_store.load

    def tearDown(self):
        main.index_store.load = self._orig_load

    def _bank(self, mapping):
        main.index_store.load = lambda sid="": mapping

    def _cats(self, *items):
        return [main.CatRef(id=cid, name=cid, pattern=pat, photos=["p"])
                for cid, pat in items]

    def test_rawsim_is_pure_cosine(self):
        """`rawSim` 必须是纯余弦（界面上「原始相似度」就是它），花色补偿不能改它。

        用 tabby 档案（与 orange 查询软冲突、非硬互斥）：硬互斥对会被
        ATTR_FILTER 直接剔除，走不到打分那一步 —— 见 TestAttrFilter。
        """
        q = _unit(1, 0, 0)
        # 0.99 相似但花色冲突：分数会被扣，rawSim 不能变
        bank = {"a": _unit(1, 0.1, 0)}
        self._bank(bank)
        out, _ = main.search(q, self._cats(("a", "tabby")),
                             "", attrs={"color": "orange", "confidence": 0.8})
        raw_expected = float(bank["a"] @ q)
        self.assertAlmostEqual(out[0]["rawSim"], round(raw_expected, 4), places=4)

    def test_attr_can_break_near_tie(self):
        """两只猫余弦几乎一样时，花色一致的那只应该排上来（需显式开启）。

        ⚠️ 档案用 gray 当「冲突」方：orange vs gray 软冲突（不同族）但
        **非硬互斥** —— cow 在 HARD_EXCLUSIVE 里会被 ATTR_FILTER 直接剔除，
        走不到破平那一步（硬互斥行为归 TestAttrFilter 管）。
        """
        q = _unit(1, 0, 0)
        bank = {
            "orange_cat": _unit(1, 0.30, 0),   # 余弦略低，花色一致
            "cow_cat": _unit(1, 0.29, 0),      # 余弦略高，花色冲突（软）
        }
        self._bank(bank)
        with mock.patch.object(config, "ATTR_RERANK", True):
            out, info = main.search(
                q, self._cats(("orange_cat", "orange"), ("cow_cat", "gray")),
                "", attrs={"color": "orange", "confidence": 0.8})
        self.assertEqual(out[0]["catId"], "orange_cat")
        self.assertIs(out[0]["attrMatch"], True)
        self.assertIs(out[1]["attrMatch"], False)
        self.assertGreater(info["reranked"], 0)

    def test_attr_off_by_default(self):
        """默认关闭：花色不能改变纯余弦的名次（8 张真实照片上它踩过坑）。"""
        self.assertFalse(config.ATTR_RERANK)
        q = _unit(1, 0, 0)
        bank = {"orange_cat": _unit(1, 0.30, 0), "cow_cat": _unit(1, 0.29, 0)}
        self._bank(bank)
        out, info = main.search(q, self._cats(("orange_cat", "orange"), ("cow_cat", "gray")),
                               "", attrs={"color": "orange", "confidence": 0.8})
        self.assertEqual(out[0]["catId"], "cow_cat")     # 纯余弦第一
        self.assertEqual(info["reranked"], 0)
        # 但诊断字段照常下发：排查时要知道「花色当时判的是冲突」
        self.assertIs(out[0]["attrMatch"], False)

    def test_attr_rerank_only_inside_band(self):
        """破平只在 ATTR_TIE_BAND 内生效：差得远时花色不能翻盘。"""
        q = _unit(1, 0, 0)
        bank = {
            "near": _unit(1, 0.02, 0),         # 余弦 ~0.9998，花色冲突（软，见上）
            "far": _unit(1, 0.60, 0),          # 余弦 ~0.857，花色一致
        }
        self._bank(bank)
        with mock.patch.object(config, "ATTR_RERANK", True):
            out, _ = main.search(q, self._cats(("near", "gray"), ("far", "orange")),
                                 "", attrs={"color": "orange", "confidence": 0.8})
        self.assertEqual(out[0]["catId"], "near")

    def test_low_confidence_attr_is_ignored(self):
        """属性置信度不足时不做重排 —— 靠数像素得出的结论不该改排名。"""
        q = _unit(1, 0, 0)
        bank = {"orange_cat": _unit(1, 0.30, 0), "cow_cat": _unit(1, 0.29, 0)}
        self._bank(bank)
        with mock.patch.object(config, "ATTR_RERANK", True):
            out, info = main.search(
                q, self._cats(("orange_cat", "orange"), ("cow_cat", "cow")),
                "", attrs={"color": "orange", "confidence": 0.2})
        self.assertEqual(info["reranked"], 0)
        self.assertEqual(out[0]["catId"], "cow_cat")     # 纯余弦排序
        self.assertNotIn("attrMatch", out[0])

    def test_min_sim_filters_on_raw(self):
        """阈值看原始余弦：0.03 的花色奖励不能把低于门槛的猫拉进候选。"""
        q = _unit(1, 0, 0)
        # 余弦 0.615（< MIN_SIM 0.62），花色一致也不该进列表
        vec = q * 0.615 + _unit(0, 1, 0) * math.sqrt(1 - 0.615 ** 2)
        bank = {"borderline": engine.l2(vec)}
        self._bank(bank)
        out, _ = main.search(q, self._cats(("borderline", "orange")),
                             "", attrs={"color": "orange", "confidence": 0.8})
        self.assertEqual(out, [])


    def test_lead_only_on_top1(self):
        q = _unit(1, 0, 0)
        bank = {"a": _unit(1, 0.10, 0), "b": _unit(1, 0.30, 0)}
        self._bank(bank)
        out, _ = main.search(q, self._cats(("a", "other"), ("b", "other")), "", attrs=None)
        self.assertIn("lead", out[0])
        self.assertNotIn("lead", out[1])
        self.assertGreater(out[0]["lead"], 0.0)

    def test_gap_floor_does_not_halve(self):
        """两只猫几乎一样时打折，但地板是 GAP_FLOOR（老值 0.5 会把真匹配打到 28 分）。"""
        q = _unit(1, 0, 0)
        bank = {"a": _unit(1, 0.05, 0), "b": _unit(1, 0.06, 0)}
        self._bank(bank)
        out, _ = main.search(q, self._cats(("a", "other"), ("b", "other")), "", attrs=None)
        raw_score = main.to_grade(out[0]["rawSim"])
        self.assertLessEqual(out[0]["score"], raw_score)
        self.assertGreaterEqual(out[0]["score"], int(raw_score * config.GAP_FLOOR) - 1)

    def test_bank_read_error_degrades(self):
        """特征库挂了只降级为空候选，不能抛。"""
        def boom(sid=""):
            raise RuntimeError("COS 不可用")
        main.index_store.load = boom
        out, info = main.search(_unit(1, 0, 0), self._cats(("a", "other")), "")
        self.assertEqual(out, [])
        self.assertIn("COS", info["bankReadError"])


class TestAttrFilter(unittest.TestCase):
    """花色硬过滤（2026-10-24）。

    现场：上传黑白奶牛猫，候选里第 2/3 名是橘猫（67.3%）和三花猫（65.2%）
    —— 用户原话「应该从毛色直接排除这两个候选」。
    这组锁的边界：只挡**物理不可能**（attrs.HARD_EXCLUSIVE），绝不把
    启发式的历史误判方向（黑白 → gray/tabby）也挡掉。
    """

    def setUp(self):
        self._orig_load = main.index_store.load
        main.index_store.load = lambda sid="": self.bank

    def tearDown(self):
        main.index_store.load = self._orig_load

    def _cats(self, *items):
        return [main.CatRef(id=cid, name=cid, pattern=pat, photos=["p"])
                for cid, pat in items]

    def test_hard_exclusive_table(self):
        """互斥表本身：黑白系 × 橘/三花/玳瑁 判死；历史误判方向必须放行。"""
        for a in ("cow", "tuxedo", "black", "white"):
            self.assertTrue(attrs.hard_exclusive(a, "orange"), a)
            self.assertTrue(attrs.hard_exclusive(a, "calico"), a)
            self.assertTrue(attrs.hard_exclusive("orange", a), a)   # 方向无关
        # 灰/狸花/暹罗与黑白系只是「不同族」，不是物理不可能 —— 历史上
        # 启发式把奶牛误判成 gray/tabby（8 张踩 2 张），挡了就是误杀
        self.assertFalse(attrs.hard_exclusive("cow", "gray"))
        self.assertFalse(attrs.hard_exclusive("cow", "tabby"))
        self.assertFalse(attrs.hard_exclusive("cow", "siamese"))
        self.assertFalse(attrs.hard_exclusive("black", "tortoiseshell"))
        # 没信息一律放行
        self.assertFalse(attrs.hard_exclusive("", "orange"))
        self.assertFalse(attrs.hard_exclusive("other", "orange"))
        self.assertFalse(attrs.hard_exclusive("cow", ""))
        self.assertFalse(attrs.hard_exclusive("cow", "乱填的值"))

    def test_user_scene_orange_and_calico_removed(self):
        """用户现场复刻：黑白奶牛查询，橘猫/三花必须从候选里消失。"""
        q = _unit(1, 0, 0)
        self.bank = {
            "mini_cow": _unit(1, 0.05, 0),    # 小奶牛（真同族，余弦最高）
            "orange_cat": _unit(1, 0.06, 0),  # 橘猫（余弦第二高，用户要求剔除）
            "calico_cat": _unit(1, 0.07, 0),  # 三花（余弦第三，用户要求剔除）
            "milk_cat": _unit(1, 0.10, 0),    # 奶牛猫（真同族）
        }
        out, info = main.search(
            q, self._cats(("mini_cow", "cow"), ("orange_cat", "orange"),
                          ("calico_cat", "calico"), ("milk_cat", "cow")),
            "", attrs={"color": "cow", "confidence": 0.8})
        got = [c["catId"] for c in out]
        self.assertNotIn("orange_cat", got)
        self.assertNotIn("calico_cat", got)
        self.assertIn("mini_cow", got)
        self.assertIn("milk_cat", got)
        self.assertEqual(info.get("attrDropped"), 2)

    def test_low_confidence_no_filter(self):
        """识别判不出花色（conf 不足）时绝不过滤 —— 没信息不等于判死。"""
        q = _unit(1, 0, 0)
        self.bank = {"orange_cat": _unit(1, 0.06, 0)}
        out, info = main.search(
            q, self._cats(("orange_cat", "orange")),
            "", attrs={"color": "cow", "confidence": 0.3})
        self.assertEqual([c["catId"] for c in out], ["orange_cat"])
        self.assertNotIn("attrDropped", info)

    def test_switch_off(self):
        """ATTR_FILTER=False 时即使硬互斥也保留（保留逃生口）。"""
        q = _unit(1, 0, 0)
        self.bank = {"orange_cat": _unit(1, 0.06, 0)}
        with mock.patch.object(config, "ATTR_FILTER", False):
            out, _ = main.search(
                q, self._cats(("orange_cat", "orange")),
                "", attrs={"color": "cow", "confidence": 0.8})
        self.assertEqual([c["catId"] for c in out], ["orange_cat"])

    def test_filter_respects_min_sim_and_topn(self):
        """硬过滤叠加在 MIN_SIM 之上，且同样受 top_n 约束。"""
        q = _unit(1, 0, 0)
        below = q * 0.60 + _unit(0, 1, 0) * math.sqrt(1 - 0.60 ** 2)   # < MIN_SIM
        self.bank = {
            "below": engine.l2(below),        # 低于阈值：花色相容也不该进
            "orange_hi": _unit(1, 0.05, 0),   # 高分但硬互斥：剔除
            "cow_ok": _unit(1, 0.12, 0),      # 同族：进
        }
        out, _ = main.search(
            q, self._cats(("below", "cow"), ("orange_hi", "orange"), ("cow_ok", "cow")),
            "", attrs={"color": "cow", "confidence": 0.8}, top_n=2)
        self.assertEqual([c["catId"] for c in out], ["cow_ok"])

    def test_unknown_pattern_passes(self):
        """档案没填花色 / 填 other：不判死，照常进候选。"""
        q = _unit(1, 0, 0)
        self.bank = {"mystery": _unit(1, 0.05, 0)}
        out, _ = main.search(
            q, self._cats(("mystery", "other")),
            "", attrs={"color": "cow", "confidence": 0.8})
        self.assertEqual([c["catId"] for c in out], ["mystery"])

    def test_empty_candidates_better_than_wrong_ones(self):
        """全是互斥档案时返回空 —— 空候选好过展示一眼假的橘猫。"""
        q = _unit(1, 0, 0)
        self.bank = {"orange_cat": _unit(1, 0.06, 0)}
        out, info = main.search(
            q, self._cats(("orange_cat", "orange")),
            "", attrs={"color": "cow", "confidence": 0.8})
        self.assertEqual(out, [])
        self.assertEqual(info.get("attrDropped"), 1)


class TestTopN(unittest.TestCase):
    """候选条数只留 Top-2（2026-10-25）。

    ⚠️ 必须与云函数 `vision.js` 的 `TOP_N` 同值：两边各写一个数字的后果是
    服务端返回 2 条、本地降级路径返回 5 条，界面候选数量随引擎状态跳变 ——
    「候选怎么有 5 只」会被误读成「库里猫多 / 识别变准了」。
    """

    def setUp(self):
        self._orig_load = main.index_store.load

    def tearDown(self):
        main.index_store.load = self._orig_load

    def _bank(self, mapping):
        main.index_store.load = lambda sid="": mapping

    def _cats(self, *items):
        return [main.CatRef(id=cid, name=cid, pattern=pat, photos=["p"])
                for cid, pat in items]

    def test_default_caps_at_two(self):
        """默认只回 2 条：库里 5 只全部过阈值时，多出来的 3 条不进候选。"""
        self.assertEqual(config.TOP_N, 2)
        q = _unit(1, 0, 0)
        # 5 只余弦都在 0.85~0.95，全部高于 MIN_SIM，靠阈值一条都筛不掉
        bank = {"c%d" % i: _unit(1, 0.05 * (i + 1), 0) for i in range(5)}
        self._bank(bank)
        out, _ = main.search(q, self._cats(*[("c%d" % i, "cow") for i in range(5)]), "")
        self.assertEqual(len(out), 2)
        # 留下的是余弦最高的两只，不是任意两只
        sims = [c["rawSim"] for c in out]
        self.assertEqual(sims, sorted(sims, reverse=True))
        self.assertEqual(out[0]["catId"], "c0")

    def test_explicit_topn_still_overrides(self):
        """显式传 top_n 时以入参为准（排查候选分布时临时放大）。"""
        q = _unit(1, 0, 0)
        bank = {"c%d" % i: _unit(1, 0.05 * (i + 1), 0) for i in range(5)}
        self._bank(bank)
        out, _ = main.search(q, self._cats(*[("c%d" % i, "cow") for i in range(5)]),
                             "", top_n=4)
        self.assertEqual(len(out), 4)

    def test_topn_under_hard_filter(self):
        """硬过滤路径同样受 2 条约束（两条分支各截一次会漏）。"""
        q = _unit(1, 0, 0)
        bank = {"c%d" % i: _unit(1, 0.05 * (i + 1), 0) for i in range(5)}
        self._bank(bank)
        out, _ = main.search(q, self._cats(*[("c%d" % i, "cow") for i in range(5)]),
                             "", attrs={"color": "cow", "confidence": 0.8})
        self.assertEqual(len(out), 2)

    def test_zero_not_swallowed_by_or_fallback(self):
        """守门断言：top_n 必须显式 None 判断，`or 默认值` 会把 0 顶掉。"""
        import inspect
        src = inspect.getsource(main.search)
        self.assertIn("top_n is not None", src,
                      "禁止 `top_n or 默认值` 写法（0 会被吞掉）")
        self.assertNotIn("top_n: int = 5", src, "默认值不该再写死 5")


if __name__ == "__main__":
    unittest.main(verbosity=2)
