"""属性识别（毛色 / 花纹 / 品种）测试（2026-10-17）。

为什么需要这个文件
------------------
CLIP 零样本分类要装 torch（镜像 +600MB），线上为了压体积基本都没开 ——
`/v1/recognize` 的 tags 里就只剩「检测 / 帧数」，用户上传白猫看不到任何毛色
信息（2026-10-17 现场问题）。`app/attrs.py` 用纯 numpy 做色域分析兜底，
这里锁死它的行为。

不依赖 torch / onnxruntime / 任何模型文件，全部用合成图验证：
  1. 单色猫（白 / 黑 / 灰 / 橘）颜色必须判对；
  2. 双色（黑白）、三色（三花）、玳瑁、狸花（条纹）的区分规则；
  3. 判不出来时返回空 + reason，**绝不硬编一个假颜色**；
  4. 输出值与前端 `miniprogram/utils/const.js` 的 PATTERN 枚举逐值对齐。

运行：python server/tests/test_attrs.py
"""
from __future__ import annotations

import os
import random
import re
import sys
import unittest

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
ROOT = os.path.dirname(SERVER)
sys.path.insert(0, SERVER)

os.environ.setdefault("INDEX_BACKEND", "sqlite")

from app import attrs, config  # noqa: E402

# 取自真实猫照的典型毛色（避免用纯饱和色 —— 纯色块会让阈值测试变成自欺欺人）
WHITE = (238, 235, 228)
BLACK = (46, 44, 42)
GRAY = (150, 152, 156)
ORANGE = (222, 152, 84)
CREAM = (152, 132, 100)     # 狸花底毛
BROWN = (110, 88, 62)       # 深棕条纹
GREEN = (90, 140, 70)       # 草地背景


def solid(rgb, size=(192, 192)):
    return Image.new("RGB", size, rgb)


def mosaic(colors, size=(192, 192), cells=8, seed=0):
    """随机色块图 —— 模拟玳瑁/三花那种**不规则**斑块。

    ⚠️ 不能用横向色带代替：色带在梯度上是各向异性的，会被条纹检测判成 tabby，
    于是「玳瑁 vs 狸花」这条规则根本测不到（玳瑁判据要求 not has_tabby）。
    """
    rng = random.Random(seed)
    im = Image.new("RGB", size)
    cw, ch = size[0] // cells, size[1] // cells
    for y in range(cells):
        for x in range(cells):
            im.paste(Image.new("RGB", (cw, ch), rng.choice(colors)), (x * cw, y * ch))
    return im


def stripes(c1, c2, size=(192, 192), band=12):
    im = Image.new("RGB", size)
    for y in range(0, size[1], band):
        c = c1 if (y // band) % 2 == 0 else c2
        im.paste(Image.new("RGB", (size[0], min(band, size[1] - y)), c), (0, y))
    return im


class TestSingleColor(unittest.TestCase):
    """单色猫：颜色判对、花纹是 solid、置信度在合理区间。"""

    def check(self, rgb, want):
        got = attrs.analyze(solid(rgb))
        self.assertEqual(got["color"], want,
                         "%s 判成了 %s（palette=%s）" % (rgb, got["color"], got["palette"]))
        self.assertEqual(got["pattern"], "solid")
        self.assertEqual(got["reason"], "")
        self.assertTrue(0.45 <= got["confidence"] <= 0.88, got["confidence"])
        return got

    def test_white(self):
        self.assertEqual(self.check(WHITE, "white")["breed"], "白猫")

    def test_black(self):
        self.assertEqual(self.check(BLACK, "black")["breed"], "黑猫")

    def test_gray(self):
        self.assertEqual(self.check(GRAY, "gray")["breed"], "灰猫")

    def test_orange(self):
        self.assertEqual(self.check(ORANGE, "orange")["breed"], "橘猫")

    def test_palette_reports_dominant_bucket(self):
        got = attrs.analyze(solid(ORANGE))
        self.assertTrue(got["palette"], "palette 不该为空")
        self.assertEqual(got["palette"][0]["key"], "orange")
        # palette 的 key 是内部色桶（orange/brown/cream…）不是前端枚举，
        # label 走 _BUCKET_LABELS，用于"为什么判成灰色"这类排查展示
        self.assertEqual(got["palette"][0]["label"], "橘")
        self.assertGreater(got["palette"][0]["ratio"], 0.5)


class TestMultiColor(unittest.TestCase):
    def test_black_white_is_cow(self):
        got = attrs.analyze(mosaic([WHITE, BLACK], seed=1))
        self.assertEqual(got["color"], "cow")
        self.assertEqual(got["pattern"], "cow")
        self.assertEqual(got["breed"], "黑白奶牛猫")

    def test_white_black_orange_is_calico(self):
        got = attrs.analyze(mosaic([WHITE, ORANGE, BLACK], seed=2))
        self.assertEqual(got["color"], "calico")
        self.assertEqual(got["breed"], "三花猫")

    def test_black_plus_warm_without_white_is_tortoiseshell(self):
        got = attrs.analyze(mosaic([BLACK, CREAM, BROWN], seed=3))
        self.assertEqual(got["color"], "tortoiseshell",
                         "palette=%s stripe=%s" % (got["palette"], got["stripe"]))
        self.assertEqual(got["breed"], "玳瑁猫")


class TestStripe(unittest.TestCase):
    def test_striped_warm_is_tabby(self):
        """米黄底 + 深棕条纹 = 狸花猫（不是橘猫）。

        band=8：2026-10-24 条纹检测换成频率法后，门槛按真实虎斑标定
        （96px 下狸花实测 11+ 个明暗周期）。band=12 缩到 96px 只有
        6 个周期，比真实猫的条纹粗一倍，会落在「斑块」区间判不出来。
        """
        got = attrs.analyze(stripes(CREAM, BLACK, band=8))
        self.assertEqual(got["color"], "tabby",
                         "palette=%s stripe=%s" % (got["palette"], got["stripe"]))
        self.assertEqual(got["pattern"], "tabby")
        self.assertGreaterEqual(got["stripe"], config.ATTR_STRIPE_MIN)

    def test_coarse_patch_is_not_tabby(self):
        """粗斑块（奶牛那种大块黑白的边界）不能骗过条纹检测。

        2026-10-24 之前的梯度方向性版本会误报（斑块边界也是强单向梯度），
        实测 4 张奶牛照全部被误判成虎斑 → 两色调规则永远够不着。
        频率法靠「重复周期数」挡住：斑块只有 1~3 条交替带。
        """
        got = attrs.analyze(stripes(CREAM, BLACK, band=48))
        self.assertNotEqual(got["pattern"], "tabby",
                            "48px 粗斑块 stripe=%s 不该判成条纹" % got["stripe"])

    def test_solid_has_no_stripe(self):
        self.assertLess(attrs.analyze(solid(ORANGE))["stripe"], 0.05)

    def test_noise_is_not_mistaken_for_stripe(self):
        """各向同性噪点不能判成条纹 —— 靠"方向性比值"，不是靠梯度绝对值。"""
        rng = random.Random(7)
        im = Image.new("RGB", (192, 192))
        im.putdata([(rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
                    for _ in range(192 * 192)])
        import numpy as np
        gray = np.asarray(im.convert("L"), dtype=np.float32)
        self.assertLess(attrs._stripe_score(gray), config.ATTR_STRIPE_MIN)


class TestRefusesToFake(unittest.TestCase):
    """判不出来必须承认，不能硬编颜色 —— 伪造属性比没有属性危害大。"""

    def test_pure_background_gives_empty_with_reason(self):
        got = attrs.analyze(solid(GREEN))
        self.assertEqual(got["color"], "")
        self.assertEqual(got["pattern"], "")
        self.assertEqual(got["breed"], "")
        self.assertTrue(got["reason"], "没判出来时必须给出原因")

    def test_tiny_image_gives_reason(self):
        got = attrs.analyze(Image.new("RGB", (4, 4), WHITE))
        self.assertEqual(got["color"], "")
        self.assertIn("太小", got["reason"])

    def test_cropped_flag_controls_background_weighting(self):
        """整图模式给边缘降权；裁剪模式（检测框已紧贴猫体）全权重。

        否则会削掉耳朵和尾巴的权重 —— 猫的耳朵尖、尾巴梢正好落在画面边缘。
        """
        im = solid(WHITE, (192, 192))
        for box in [(0, 0, 192, 24), (0, 168, 192, 192),
                    (0, 0, 24, 192), (168, 0, 192, 192)]:
            im.paste(Image.new("RGB", (box[2] - box[0], box[3] - box[1]), GREEN), box[:2])
        loose = attrs.analyze(im, cropped=False)
        tight = attrs.analyze(im, cropped=True)
        self.assertEqual(loose["color"], "white")
        self.assertEqual(tight["color"], "white")
        # 整图模式边缘降权 → 主色占比更集中；裁剪模式边缘全算数 → 被背景色稀释
        self.assertGreater(loose["palette"][0]["ratio"],
                           tight["palette"][0]["ratio"],
                           "整图模式应给边缘降权，让主色更突出")


class TestContractWithFrontend(unittest.TestCase):
    """取值必须与 miniprogram/utils/const.js 的 PATTERN 枚举一致。

    对不上就是前端把 `orange` 原样显示给用户（早期实际就是这样）。
    """

    def test_values_match_frontend_enum(self):
        path = os.path.join(ROOT, "miniprogram", "utils", "const.js")
        if not os.path.exists(path):
            self.skipTest("找不到 const.js（只跑服务端测试时跳过）")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        block = re.search(r"PATTERN:\s*\[(.*?)\]", src, re.S)
        self.assertIsNotNone(block, "const.js 里没找到 PATTERN 枚举")
        values = set(re.findall(r"value:\s*'([^']+)'", block.group(1)))
        self.assertEqual(values, set(attrs.COLOR_LABELS),
                         "服务端 COLOR_LABELS 与前端枚举不一致：缺 %s / 多 %s"
                         % (values - set(attrs.COLOR_LABELS),
                            set(attrs.COLOR_LABELS) - values))

    def test_every_pattern_has_chinese_label(self):
        """花纹维度是独立的展示字段，每个取值都必须有中文，不能漏成英文。"""
        for v, label in attrs.PATTERN_LABELS.items():
            self.assertTrue(label and not label.isascii(), "%s 缺少中文标签" % v)
        self.assertIn("solid", attrs.PATTERN_LABELS, "纯色猫必须有 solid 的中文文案")

    def test_breed_covers_every_color(self):
        for v in attrs.COLOR_LABELS:
            if v in ("other", "siamese"):
                continue
            self.assertTrue(attrs._breed_of(v, "solid"),
                            "%s 没有对应的品种文案" % v)


class TestRemoteDisabledByDefault(unittest.TestCase):
    def test_no_network_when_url_empty(self):
        old = config.ATTR_API_URL
        config.ATTR_API_URL = ""
        try:
            self.assertIsNone(attrs._remote(solid(WHITE)))
        finally:
            config.ATTR_API_URL = old

    def test_detect_falls_back_to_local(self):
        old = config.ATTR_API_URL
        config.ATTR_API_URL = ""
        try:
            got = attrs.detect(solid(ORANGE))
        finally:
            config.ATTR_API_URL = old
        self.assertEqual(got["color"], "orange")
        self.assertEqual(got["source"], "heuristic")


class _FakeClf:
    def __init__(self, out):
        self.out = out

    def __call__(self, im):
        return self.out


class _FakeClfRaising:
    def __call__(self, im):
        raise RuntimeError("模型炸了")


class TestEngineAttrFallback(unittest.TestCase):
    """CLIP 与启发式的衔接：高置信用 CLIP，低置信/异常落到启发式。"""

    def _engine(self, clf):
        from app import engine as engine_mod
        e = engine_mod.Engine.__new__(engine_mod.Engine)
        e.clf = clf
        return e

    def test_high_confidence_clip_wins(self):
        e = self._engine(_FakeClf(("orange", "tabby", 0.9)))
        got = e.attrs(solid(WHITE))     # 图是白的，但 CLIP 很有信心
        self.assertEqual(got["source"], "clip")
        self.assertEqual(got["color"], "orange")
        self.assertEqual(got["breed"], "橘狸花")

    def test_low_confidence_clip_yields_to_heuristic(self):
        """用户提的 50% 线：CLIP 置信度低于它就不采信，改用色域分析。"""
        e = self._engine(_FakeClf(("black", "solid", 0.2)))
        got = e.attrs(solid(ORANGE))
        self.assertEqual(got["source"], "heuristic")
        self.assertEqual(got["color"], "orange")

    def test_clip_exception_does_not_break_recognition(self):
        e = self._engine(_FakeClfRaising())
        got = e.attrs(solid(WHITE))
        self.assertEqual(got["color"], "white")

    def test_low_confidence_clip_kept_when_heuristic_also_fails(self):
        """启发式也判不出来时，CLIP 的低置信结果带上 reason 兜底，不是直接丢空。"""
        e = self._engine(_FakeClf(("siamese", "pointed", 0.2)))
        got = e.attrs(solid(GREEN))     # 纯背景，启发式判不出
        self.assertEqual(got["source"], "clip")
        self.assertIn("仅供参考", got["reason"])


class TestCalicoLooseGate(unittest.TestCase):
    """宽松三花规则必须有鲜明橘（2026-10-26）。

    实测橘猫标准素材（浅橘/乳橘猫 + 白墙背景 + 阴影）被判成三花：
    white=0.285 全来自墙、dark=0.31 全来自阴影、warm=0.28 全来自落进
    brown 桶的低饱和橘毛，orange 桶只有 0.003 —— 宽松规则原本不看
    orange，原封不动命中。数据取自该素材的真实统计。
    """

    def _ratio(self, orange):
        return {"white": 0.285, "black": 0.081, "gray": 0.311,
                "orange": orange, "brown": 0.279, "cream": 0.014, "red": 0.002}

    def test_buff_cat_against_wall_is_not_calico(self):
        color, _ = attrs._decide(self._ratio(0.003), stripe=0.48, dgray=0.227)
        self.assertNotEqual(color, "calico", "没有鲜明橘不能判三花")
        self.assertEqual(color, "orange", "白+暖+无鲜明橘应落到橘系（橘白）")

    def test_loose_calico_with_vivid_orange_still_works(self):
        color, pattern = attrs._decide(self._ratio(0.06), stripe=0.1, dgray=0.05)
        self.assertEqual(color, "calico")
        self.assertEqual(pattern, "calico")

    def test_strict_calico_rule_unaffected(self):
        """严格三花规则本就有 orange>=0.08 门槛，加宽松门槛不能破坏它。"""
        got = attrs.analyze(mosaic([WHITE, ORANGE, BLACK], seed=2))
        self.assertEqual(got["color"], "calico")


class TestTabbyWarmGate(unittest.TestCase):
    """狸花判定必须有暖色底毛（2026-10-26）。

    实测黑猫标准素材（黑猫趴灰沙发）被判成狸花：stripe=0.63 过线，
    但条纹分全部来自沙发布纹的方向性褶皱，暖色系像素（H5~55、S≥50，
    不限亮度）只有 6.8%。真狸花的暖色底毛远高于此。数据取自真实统计。
    """

    def _ratio(self):
        return {"white": 0.0, "black": 0.297, "gray": 0.637, "orange": 0.003,
                "brown": 0.025, "cream": 0.0, "red": 0.0}

    def test_black_cat_on_sofa_is_not_tabby(self):
        color, pattern = attrs._decide(self._ratio(), stripe=0.7, dgray=0.59,
                                       warmish=0.068)
        self.assertEqual(color, "black", "黑猫+织物纹理不能判成狸花")
        self.assertEqual(pattern, "solid")

    def test_tabby_with_warm_base_still_tabby(self):
        """暖色底毛够量时，狸花判定不受影响（规则 7 主路径）。"""
        ratio = {"white": 0.05, "black": 0.05, "gray": 0.45, "orange": 0.0,
                 "brown": 0.05, "cream": 0.15, "red": 0.0}
        color, pattern = attrs._decide(ratio, stripe=0.9, dgray=0.15, warmish=0.25)
        self.assertEqual(color, "tabby")
        self.assertEqual(pattern, "tabby")

    def test_low_warm_degrades_to_gray_not_tabby(self):
        """暖色不足时降级为灰猫（花纹仍是条纹），而不是硬判狸花。"""
        ratio = {"white": 0.05, "black": 0.05, "gray": 0.45, "orange": 0.0,
                 "brown": 0.05, "cream": 0.15, "red": 0.0}
        color, pattern = attrs._decide(ratio, stripe=0.9, dgray=0.15, warmish=0.05)
        self.assertEqual(color, "gray")
        self.assertEqual(pattern, "tabby")

    def test_missing_warmish_keeps_old_behavior(self):
        """没传 warmish（None）= 没有这项证据 → 门槛不生效，旧调用不受影响。"""
        ratio = {"white": 0.05, "black": 0.05, "gray": 0.45, "orange": 0.0,
                 "brown": 0.05, "cream": 0.15, "red": 0.0}
        color, _ = attrs._decide(ratio, stripe=0.9, dgray=0.15)
        self.assertEqual(color, "tabby")

    def test_warmish_stat_is_exposure_immune(self):
        """warmish 统计本身不看亮度：把狸花底毛压暗到夜里，占比不塌。"""
        bright = attrs.analyze(solid(CREAM))
        dark_im = solid(CREAM).point(lambda p: int(p * 0.35))   # 压到 35% 亮度
        dark = attrs.analyze(dark_im)
        self.assertGreater(bright["_stats"]["warmish"], 0.9)
        self.assertGreater(dark["_stats"]["warmish"], 0.9,
                           "S/H 对亮度免疫，压暗不应让暖色证据消失")
        # 纯色无条纹 → 走规则 6 的既有兜底（暖色主导 + 无鲜明橘 → 橘系纯色）；
        # 这条断言锁的是「暖色证据在夜间仍然生效」，不是条纹判定。
        self.assertEqual(dark["color"], "orange")


if __name__ == "__main__":
    unittest.main(verbosity=2)
