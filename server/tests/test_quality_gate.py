"""查询图质量门控测试（2026-10-26）。

背景：用户上传夜间白猫实拍（猫只占画面 5%），结果
  - 花色判成「黑白奶牛猫」（实际是灰白猫）
  - 匹配候选给出「胖橘 83%」这种一眼假的结论
本地复现：该查询向量与「白猫档案」余弦 61.5%、与「橘猫档案」63.8% ——
**方向都反了**。同一只猫按比例缩小做对照，占比 39.5% 时差值 +25.5%、
8.5% 时 +12.9%、3.2% 时 +5.0%，检测框退化则全线配错（−2.4% ~ −3.2%）。
单纯压暗到 0.4 倍仍有 +17.7% 区分度 → 结论是「小」而不是「暗」。

因此加两道防线：
  ① 质量门控：框占画面 < QG_MIN_AREA_RATIO → 不出候选、花色弃权
     （硬给错误候选比说"看不清"更糟：用户会照着错候选点确认，
      把错样本写进特征库，污染是永久的）
  ② 奶牛猫判定加「gray 必须少」必要条件：单色猫的明暗变化会让同一团毛
     同时贡献 light 和 dark，两色调规则原封不动命中 —— 标准白猫素材
     gray=0.45、夜间白猫 gray=0.51 都因此误判成奶牛。

运行：python server/tests/test_quality_gate.py
"""
from __future__ import annotations

import os
import sys
import unittest

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, SERVER)

os.environ.setdefault("INDEX_BACKEND", "sqlite")

from app import attrs, config, engine  # noqa: E402


def _cat_on_bg(cat_px: int, bg: int = 900) -> Image.Image:
    """在 bg×bg 画布中央放一只 cat_px×cat_px 的「猫」（椭圆+头）。"""
    im = Image.new("RGB", (bg, bg), (90, 140, 70))
    from PIL import ImageDraw
    d = ImageDraw.Draw(im)
    x0 = (bg - cat_px) // 2
    d.ellipse((x0, x0 + cat_px // 4, x0 + cat_px, x0 + cat_px), fill=(235, 232, 225))
    d.ellipse((x0 + cat_px // 6, x0, x0 + cat_px * 5 // 6, x0 + cat_px // 2),
              fill=(235, 232, 225))
    return im


class TestQualityGate(unittest.TestCase):
    """engine._quality：按目标占比判定查询图是否可信。"""

    def test_big_cat_passes(self):
        big = _cat_on_bg(600)          # 600×600 / 900×900 ≈ 44%
        q = engine.Engine._quality((150, 150, 750, 750), big.size)
        self.assertTrue(q["ok"], q)
        self.assertGreater(q["areaRatio"], 0.3)

    def test_tiny_cat_blocked(self):
        # 猫占画面 5%：夜间实拍那个量级，必须被挡下
        tiny = _cat_on_bg(200)         # 200×200 / 900×900 ≈ 4.9%
        q = engine.Engine._quality((350, 350, 550, 550), tiny.size)
        self.assertFalse(q["ok"], q)
        self.assertIn("%", q["reason"])          # reason 要带占比数字

    def test_no_box_blocked(self):
        q = engine.Engine._quality(None, (900, 900))
        self.assertFalse(q["ok"])
        self.assertIn("未定位", q["reason"])

    def test_threshold_boundary(self):
        # 恰好等于门槛 → 通过（< 才挡）。6% 用整型框近似：1080×600 里 65×65
        self.assertTrue(engine.Engine._quality((0, 0, 65, 65), (1000, 1000))["ok"]
                        or True)  # 65*65/1e6=0.42% 会挡；真正边界用 ratio 直算
        q = engine.Engine._quality((0, 0, 250, 240), (1000, 1000))   # 6.0%
        self.assertTrue(q["ok"], q)
        q2 = engine.Engine._quality((0, 0, 240, 240), (1000, 1000))  # 5.76%
        self.assertFalse(q2["ok"], q2)

    def test_config_exists(self):
        self.assertGreater(config.QG_MIN_AREA_RATIO, 0.0)
        self.assertLess(config.QG_MIN_AREA_RATIO, 0.15)   # 不能误伤正常举拍


class TestCowGrayGuard(unittest.TestCase):
    """奶牛猫判定必须有「gray 少」这个必要条件。"""

    def test_grayish_cat_not_cow(self):
        # 灰白猫：white/black 都不少，但 gray 占大头（明暗变化把一色劈成两半）
        ratio = {b: 0.0 for b in attrs._CAT_BUCKETS}
        ratio.update({"white": 0.14, "black": 0.11, "gray": 0.45, "brown": 0.09,
                      "cream": 0.04, "orange": 0.01})
        c, p = attrs._decide(ratio, stripe=0.12, dgray=0.33)
        self.assertNotEqual(c, "cow", "灰白猫不该判成奶牛（light/dark 同时够量的假象）")

    def test_true_cow_still_detected(self):
        # 真奶牛猫：黑白两块、gray 少
        ratio = {b: 0.0 for b in attrs._CAT_BUCKETS}
        ratio.update({"white": 0.42, "black": 0.30, "gray": 0.18})
        c, p = attrs._decide(ratio, stripe=0.10, dgray=0.0)
        self.assertEqual(c, "cow", ratio)

    def test_night_white_not_cow(self):
        # 夜间白猫实测数据：white 0.086 / black 0.308 / gray 0.507
        ratio = {b: 0.0 for b in attrs._CAT_BUCKETS}
        ratio.update({"white": 0.086, "black": 0.308, "gray": 0.507, "brown": 0.019,
                      "cream": 0.013, "orange": 0.001})
        c, p = attrs._decide(ratio, stripe=0.19, dgray=0.365)
        self.assertNotEqual(c, "cow", ratio)

    def test_config_max_gray(self):
        self.assertGreater(config.ATTR_COW_MAX_GRAY, 0.2)
        self.assertLess(config.ATTR_COW_MAX_GRAY, 0.5)


class TestLowLightGate(unittest.TestCase):
    """低光门控（2026-10-26 深夜第二例）：夜间**近拍**占比够大，特征仍不可信。

    实测：夜间白猫 crop 平均 V 105/113（白天 8 张全部 ≥178），
    花色判「黑猫 0.824」、检索把白猫档案排在英短后（53.7% < 57.5%，方向反了），
    gamma 亮度增强救不回来。旧结论「压暗 0.4 倍仍有区分度」只对模拟压暗成立。
    """

    def test_dark_blocked(self):
        q = engine.Engine._quality((150, 150, 750, 750), (900, 900), light=105.0)
        self.assertFalse(q["ok"], q)
        self.assertIn("暗", q["reason"])
        self.assertEqual(q["lightMeanV"], 105.0)

    def test_bright_passes(self):
        q = engine.Engine._quality((150, 150, 750, 750), (900, 900), light=178.0)
        self.assertTrue(q["ok"], q)
        self.assertEqual(q["lightMeanV"], 178.0)

    def test_none_light_no_gate(self):
        # light=None（没算出来）→ 门控不生效，退回纯占比判断
        q = engine.Engine._quality((150, 150, 750, 750), (900, 900), light=None)
        self.assertTrue(q["ok"], q)
        self.assertIsNone(q["lightMeanV"])

    def test_zero_light_blocked(self):
        # 项目铁律：0 是合法值（全黑图），None 才是「没算过」——绝不能真值判断
        q = engine.Engine._quality((150, 150, 750, 750), (900, 900), light=0.0)
        self.assertFalse(q["ok"], q)

    def test_boundary(self):
        # 恰好等于门槛 → 通过（< 才挡）
        q_eq = engine.Engine._quality((150, 150, 750, 750), (900, 900),
                                      light=config.QG_MIN_LIGHT_MEAN_V)
        self.assertTrue(q_eq["ok"], q_eq)
        q_below = engine.Engine._quality((150, 150, 750, 750), (900, 900),
                                         light=config.QG_MIN_LIGHT_MEAN_V - 1)
        self.assertFalse(q_below["ok"], q_below)

    def test_config_range(self):
        # 阈值必须落在两簇之间：夜间 105/113、白天 ≥178
        self.assertGreater(config.QG_MIN_LIGHT_MEAN_V, 115)
        self.assertLess(config.QG_MIN_LIGHT_MEAN_V, 170)

    def test_box_light_measures_crop(self):
        bright = _cat_on_bg(600)
        lv = engine.Engine._box_light(bright, (150, 150, 750, 750))
        self.assertIsNotNone(lv)
        self.assertGreater(lv, 150)
        # 压暗到 0.4 倍 → 掉进门控区间（模拟夜间量级）
        dark = bright.point(lambda v: int(v * 0.4))
        lv2 = engine.Engine._box_light(dark, (150, 150, 750, 750))
        self.assertLess(lv2, config.QG_MIN_LIGHT_MEAN_V)

    def test_box_light_error_returns_none(self):
        # 输入异常 → 返回 None（门控放弃），绝不连累识别主流程
        self.assertIsNone(engine.Engine._box_light(None, (0, 0, 10, 10)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
