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

import numpy as np
from PIL import Image, ImageFilter

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
        """暖色不足**且没有亮灰底毛**时降级为灰猫（花纹仍是条纹），不硬判狸花。

        dgray 高（0.38）说明 gray 桶里全是暗灰（阴影/条纹自身），light 只有
        0.12 < 0.15 —— 这正是 2026-10-31 给规则 7 加「亮灰证据」时要挡住的
        「深灰猫 + 环境纹理」场景。银虎斑（亮灰底毛、light≥0.15）另见
        test_silver_tabby_with_bright_gray_is_tabby。
        """
        ratio = {"white": 0.05, "black": 0.05, "gray": 0.45, "orange": 0.0,
                 "brown": 0.05, "cream": 0.15, "red": 0.0}
        color, pattern = attrs._decide(ratio, stripe=0.9, dgray=0.38, warmish=0.05)
        self.assertEqual(color, "gray")
        self.assertEqual(pattern, "tabby")

    def test_silver_tabby_with_bright_gray_is_tabby(self):
        """亮灰底毛（light≥0.15）+ 条纹 → 狸花，即使暖色证据很低。

        实测「狸花猫2.jpg」判成纯白：white 0.089 / black 0.363 / gray 0.444 /
        dgray 0.275（light=0.258）、warmish 0.059、stripe 0.617。
        """
        ratio = {"white": 0.089, "black": 0.363, "gray": 0.444, "orange": 0.0,
                 "brown": 0.027, "cream": 0.001, "red": 0.0}
        color, pattern = attrs._decide(ratio, stripe=0.617, dgray=0.275, warmish=0.059)
        self.assertEqual(color, "tabby")
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


class TestOcclusionAndBodyWhiteCalico(unittest.TestCase):
    """遮挡物混进掩膜 / 白身三花的局部斑块（2026-11-05 现场）。

    素材：E:\\Agent\\worker\\东南大学-猫\\原图 18 张实拍，以下三个用例直接
    使用分析器的真实统计值，锁住当天两处塌方：

      1. 奶牛猫4.jpg —— u2netp 把整条人手+红袖算成猫体，皮肤暖色把 warmish
         顶到 0.376、brown 顶到 0.169，奶牛规则被暖色闸挡死 → 判成纯白
         （线上版本甚至落到「橘猫」）。修复：规则 3a 只看中性黑白证据。
      2. 三花-身体白头三花*.jpg —— 橘/黑块只在头上，全局 orange 0.003~0.008，
         规则 1/2b 够不着，反被规则 5（白+暖）吞成橘猫。修复：规则 2c 用
         「浅色身体 + 棕橘块 + 小面积真黑」的组合。
      3. 狸花猫2.jpg —— 灰底狸花 stripe 0.59 差 0.01 到线、warmish 只有 0.059，
         两头够不着 → 判成纯白。修复：弱条纹带接受 light≥0.15 的亮灰证据。
    """

    def _decide(self, ratio, **kw):
        return attrs._decide(ratio, **kw)

    def test_cow_with_hand_in_mask(self):
        """人手/红袖在掩膜里 → 仍然是奶牛，不能被暖色证据顶成白/橘。"""
        ratio = {"white": 0.346, "black": 0.131, "gray": 0.181,
                 "orange": 0.006, "brown": 0.169, "cream": 0.056, "red": 0.0}
        color, pattern = self._decide(ratio, stripe=0.17, dgray=0.061,
                                      warmish=0.376, bright=0.419, sat=47.0,
                                      pale=0.043)
        self.assertEqual(color, "cow")
        self.assertEqual(pattern, "cow")

    def test_body_white_calico_not_orange(self):
        """白身三花：橘块只在头上，全局占比被稀释也不能判成橘猫。"""
        cases = [
            ({ "white": 0.244, "black": 0.083, "gray": 0.402, "orange": 0.008,
               "brown": 0.180, "cream": 0.023, "red": 0.0 },
             0.11, 0.159, 0.277),
            ({ "white": 0.450, "black": 0.022, "gray": 0.293, "orange": 0.004,
               "brown": 0.160, "cream": 0.043, "red": 0.0 },
             0.11, 0.066, 0.233),
            ({ "white": 0.232, "black": 0.033, "gray": 0.458, "orange": 0.003,
               "brown": 0.188, "cream": 0.019, "red": 0.0 },
             0.60, 0.038, 0.240),
        ]
        for ratio, stripe, dgray, warmish in cases:
            color, pattern = self._decide(ratio, stripe=stripe, dgray=dgray,
                                          warmish=warmish)
            self.assertEqual(color, "calico", "白身三花被判成 %s" % color)
            self.assertEqual(pattern, "calico")

    def test_gray_tabby_just_below_stripe_gate(self):
        """灰底狸花：stripe 0.59 < 0.60 但 light 够亮 → 仍要判狸花，不是纯白。"""
        ratio = {"white": 0.086, "black": 0.357, "gray": 0.454,
                 "orange": 0.000, "brown": 0.027, "cream": 0.001, "red": 0.0}
        color, pattern = self._decide(ratio, stripe=0.59, dgray=0.283,
                                      warmish=0.058)
        self.assertEqual(color, "tabby")
        self.assertEqual(pattern, "tabby")

    def test_buff_cat_against_wall_stays_out_of_calico(self):
        """乳橘猫+白墙+阴影：brown 高但整身偏暖 → 不能被 2c 吞成三花。"""
        ratio = {"white": 0.285, "black": 0.081, "gray": 0.311,
                 "orange": 0.003, "brown": 0.279, "cream": 0.014, "red": 0.0}
        color, _ = self._decide(ratio, stripe=0.1, dgray=0.227, warmish=0.31)
        self.assertNotEqual(color, "calico")


class TestDarkLight(unittest.TestCase):
    """暗光 / 眩光场景（2026-10-28）：夜间点光源照片的实测塌方点。

    一盏灯把 V 的 p98 锚点顶到 240+，严重欠曝的画面误判「曝光正常」，
    白毛整桶掉进灰/黑（夜间白猫判「黑猫 0.824」的锚点侧成因）。
    （同期试过「暗图直方图均衡救条纹」，逐分不差，已撤 —— 见 attrs._stats_of 注释。）
    """

    def test_glare_does_not_hijack_exposure_anchor(self):
        """~7% 的点光源像素不该把曝光锚点从猫体（V≈100）劫持到 255。"""
        v = np.full((96, 96), 100.0, dtype=np.float32)
        s = np.full((96, 96), 60.0, dtype=np.float32)
        v[:26, :24] = 255.0                      # 角落一盏灯（6.8%，够劫持 p98）
        s[:26, :24] = 0.0
        w = np.ones((96, 96), dtype=np.float64)
        shift = attrs._exposure_shift(v, w, s)
        self.assertLess(shift, 0.0,
                        "剔除眩光后锚点应落在猫体亮度上限（~100），shift 应为负")
        legacy = attrs._exposure_shift(v, w)     # 不传 s = 旧行为
        self.assertGreater(legacy, 0.0, "旧锚点被眩光劫持到 255，shift 为正")

    def test_glare_majority_keeps_original_anchor(self):
        """画面主体本身白亮（白天白猫）时，放弃剔除 —— 否则连锚点都被剔没。"""
        v = np.full((96, 96), 252.0, dtype=np.float32)
        s = np.zeros((96, 96), dtype=np.float32)
        v[:30, :] = 100.0                        # 31% 暗部，69% 都是"眩光"量级
        w = np.ones((96, 96), dtype=np.float64)
        shift = attrs._exposure_shift(v, w, s)
        self.assertGreater(shift, 0.0, "眩光占比过半时必须保留原锚点")


def textured(rgb, size=(256, 256), noise=28, seed=11):
    """带高频细节的纯色图 —— 模拟「真实照片有毛发纹理」，清晰度门控才能测到。

    纯色块（`solid()`）的 Laplacian 方差≈0，会被当成糊片；真实猫毛在 512
    口径下有 106~2300 的细节能量。用 ±noise 的像素噪声来代表这层纹理。
    """
    rng = np.random.default_rng(seed)
    base = np.array(rgb, dtype=np.int16)
    arr = np.zeros((size[1], size[0], 3), dtype=np.int16) + base
    arr = arr + rng.integers(-noise, noise + 1, size=arr.shape, dtype=np.int16)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


class TestQualityGate(unittest.TestCase):
    """照片可用性门控（2026-11-05）。

    设计目标不是「判得更准」，而是**把判不准的素材挡在结论之前**：
    糊片返回空 + 重拍提示，而不是用噪声直方图硬凑一个花色。
    阈值按 34 张真实素材（18 实拍 + 16 标准照）的保守下限标定，见
    config.ATTR_QUALITY_GATE 的注释。
    """

    def _mask(self, size=(256, 256)):
        return np.ones((size[1], size[0]), dtype=np.float32)

    def test_sharp_photo_passes(self):
        got = attrs.analyze(textured(ORANGE), cropped=True, mask=self._mask())
        self.assertFalse(got.get("refused"))
        self.assertEqual(got["color"], "orange")

    def test_blurry_photo_refused_with_retake_hint(self):
        im = textured(ORANGE).filter(ImageFilter.GaussianBlur(6))
        got = attrs.analyze(im, cropped=True, mask=self._mask())
        self.assertTrue(got.get("refused"), "糊片应被质量门拦下")
        self.assertEqual(got["color"], "")
        self.assertIn("模糊", got["reason"])
        self.assertIn("重拍", got["reason"])

    def test_missing_subject_refused(self):
        """掩膜几乎全空（猫被完全挡住 / 抠图失败）→ 拒识，而不是判背景色。"""
        m = np.zeros((200, 200), dtype=np.float32)
        m[100:102, 100:102] = 1.0               # 4 个像素 = 0.01%
        got = attrs.analyze(textured(ORANGE, (200, 200)), cropped=True, mask=m)
        self.assertTrue(got.get("refused"))
        self.assertIn("遮挡", got["reason"])

    def test_gate_can_be_disabled(self):
        old = config.ATTR_QUALITY_GATE
        config.ATTR_QUALITY_GATE = False
        try:
            got = attrs.analyze(textured(ORANGE).filter(ImageFilter.GaussianBlur(6)),
                                cropped=True, mask=self._mask())
        finally:
            config.ATTR_QUALITY_GATE = old
        self.assertFalse(got.get("refused"))
        self.assertEqual(got["color"], "orange")

    def test_no_mask_skips_gate(self):
        """没有掩膜时不做质量判断（合成图单测/未启用抠图的部署保持旧行为）。"""
        got = attrs.analyze(textured(ORANGE).filter(ImageFilter.GaussianBlur(6)))
        self.assertFalse(got.get("refused"))

    def test_merge_propagates_refusal(self):
        """多帧全被拒识时，把重拍原因带出去，不能退化成 None。"""
        refused = attrs._empty("照片偏模糊，请重拍", refused=True)
        out = attrs.merge_and_decide([refused, dict(refused)])
        self.assertIsNotNone(out)
        self.assertTrue(out.get("refused"))
        self.assertIn("模糊", out["reason"])

    def test_engine_refusal_beats_low_confidence_clip(self):
        """素材不可用时，低置信 CLIP 的猜测不能覆盖拒识结论。"""
        from app import engine as engine_mod
        e = engine_mod.Engine.__new__(engine_mod.Engine)
        e.clf = _FakeClf(("black", "solid", 0.2))
        got = e.attrs(textured(ORANGE).filter(ImageFilter.GaussianBlur(6)),
                      cropped=True, mask=self._mask())
        self.assertTrue(got.get("refused"))
        self.assertEqual(got["color"], "")


class TestConsistencyGate(unittest.TestCase):
    """口径一致性门控（2026-11-05）。

    现场：同一只黑白猫，裁掉一部分画面后从 cow 变成 orange。
    根因不是阈值，而是**输入变了** —— 裁剪让检测框变松、u2netp 把过曝的
    白毛整块丢掉、又把人的手抠成前景，于是 white 0.35→0.16、cream 0.06→0.17、
    warmish 0.38→0.50，暖色闸（≤0.34）一破就落到橘猫分支。
    修法：让「掩膜口径」和「整幅口径」互查，互斥且抠图不完整就弃权。
    """

    def _mask(self, w=200, h=100, span=1.0):
        """只覆盖左侧 span 比例的前景掩膜。"""
        m = np.zeros((h, w), dtype=np.float32)
        m[:, :max(1, int(w * span))] = 1.0
        return m

    def test_extent_measures_horizontal_span(self):
        self.assertAlmostEqual(attrs._mask_extent(self._mask(200, 100, 0.5)), 0.5, places=2)
        self.assertAlmostEqual(attrs._mask_extent(self._mask(200, 100, 1.0)), 1.0, places=2)
        self.assertIsNone(attrs._mask_extent(None))

    def test_contradiction_with_broken_mask_refuses(self):
        """互斥 + 抠图不完整 → 弃权（这是「裁剪后判成橘猫」的那张图）。"""
        why = attrs._consistency_gate("orange", "cow", 0.51)
        self.assertTrue(why)
        self.assertIn("遮挡", why)
        self.assertIn("重试", why)

    def test_contradiction_with_full_mask_keeps_mask_verdict(self):
        """掩膜完整时互斥说明整幅统计被背景污染（白猫黑天），不能打扰用户。"""
        self.assertEqual(attrs._consistency_gate("white", "black", 0.86), "")

    def test_non_exclusive_pair_never_refuses(self):
        """三花 vs 狸花这类不互斥的组合照旧给结论。"""
        self.assertEqual(attrs._consistency_gate("calico", "tabby", 0.40), "")
        self.assertEqual(attrs._consistency_gate("orange", "tabby", 0.30), "")

    def test_empty_side_never_refuses(self):
        self.assertEqual(attrs._consistency_gate("", "cow", 0.30), "")
        self.assertEqual(attrs._consistency_gate("orange", "", 0.30), "")

    def test_analyze_refuses_on_contradiction(self):
        """走完整 analyze()：掩膜只盖住「手」那块，其余是黑白毛 → 拒识。

        构造的就是现场那张图的统计形态：被遮挡区域全暖色，其余是白+黑毛。
        整幅口径因此判三花/奶牛，掩膜口径判橘猫 —— 两者互斥，且抠图横向
        只覆盖 65%，说明猫体没抠全，此时不该硬给一个结论。
        """
        w, h = 240, 120
        arr = np.zeros((h, w, 3), dtype=np.uint8)
        arr[:, :] = (245, 245, 245)             # 白毛
        arr[:, 150:200] = (20, 20, 20)          # 黑块
        arr[0:55, 60:105] = 35                  # 黑块
        arr[76:120, 0:156] = (255, 140, 40)     # 左下：被抠进掩膜的暖色（手）
        im = Image.fromarray(arr)
        mask = np.zeros((h, w), dtype=np.float32)
        mask[76:120, 0:156] = 1.0
        got = attrs.analyze(im, cropped=True, mask=mask)
        self.assertTrue(got.get("refused"), "互斥口径 + 抠图不完整 应弃权")
        self.assertEqual(got["color"], "")
        self.assertIn("遮挡", got["reason"])
        self.assertEqual(got["consistency"]["mask"], "orange")

    def test_gate_off_keeps_old_verdict(self):
        old = config.ATTR_CONSISTENCY_GATE
        config.ATTR_CONSISTENCY_GATE = False
        try:
            got = attrs.analyze(textured(ORANGE), cropped=True, mask=self._mask(256, 256, 1.0))
        finally:
            config.ATTR_CONSISTENCY_GATE = old
        self.assertFalse(got.get("refused"))
        self.assertEqual(got["color"], "orange")


class TestPatternEngine(unittest.TestCase):
    """`ATTR_ENGINE=pattern` 的切换契约（2026-11-10）。

    tools/pattern_recognize.py 是另一套判定口径（6 色桶 + 分带布局 + 斑块度
    + 边缘肤色剔除）。它必须满足三件事，否则不能作为可选项上线：
      1. 输出与 legacy **逐字段同契约**（color/pattern/breed/confidence/
         palette/source/reason/refused），engine/main/search 不用改；
      2. 素材不可用时同样拒识并给重拍文案（用户明确的「不好识别就说」）；
      3. 加载/运行失败时**自动回退 legacy**，不能成为单点故障。
    """

    def setUp(self):
        self._old = getattr(config, "ATTR_ENGINE", "pattern")
        self._pat = dict(attrs._PATTERN)
        config.ATTR_ENGINE = "pattern"

    def tearDown(self):
        config.ATTR_ENGINE = self._old
        attrs._PATTERN.clear()
        attrs._PATTERN.update(self._pat)

    def _mask(self, size=(256, 256)):
        return np.ones((size[1], size[0]), dtype=np.float32)

    def test_pattern_returns_legacy_contract(self):
        got = attrs.detect(textured(WHITE), cropped=True, mask=self._mask())
        self.assertEqual(got["engine"], "pattern")
        self.assertEqual(got["source"], "heuristic")
        self.assertEqual(got["color"], "white")
        self.assertTrue(got["breed"])
        self.assertIsInstance(got["palette"], list)
        self.assertTrue(got["palette"], "调色板不能为空（前端要画色块条）")
        self.assertIn(got["palette"][0]["key"],
                      ("white", "black", "gray", "orange", "brown"))
        self.assertGreater(got["confidence"], 0.0)
        self.assertFalse(got["refused"])

    def test_pattern_refuses_blurry_photo(self):
        got = attrs.detect(textured(ORANGE).filter(ImageFilter.GaussianBlur(6)),
                           cropped=True, mask=self._mask())
        self.assertTrue(got["refused"])
        self.assertEqual(got["color"], "")
        self.assertIn("重拍", got["reason"])

    def test_falls_back_to_legacy_when_pattern_unavailable(self):
        """pattern 加载失败（例如 tools/ 没打进镜像）不能拖垮识别。"""
        attrs._PATTERN["tried"] = True
        attrs._PATTERN["mod"] = None
        got = attrs.detect(textured(ORANGE), cropped=True, mask=self._mask())
        self.assertEqual(got["color"], "orange")
        self.assertNotEqual(got.get("engine"), "pattern", "回退时应是 legacy 的结果")

    def test_pattern_unknown_returns_empty_color(self):
        """判不出花色时 color 必须是空串（不是 "unknown"），否则会挡住 CLIP 兜底。"""
        got = attrs.detect(solid(GREEN), cropped=True)
        self.assertEqual(got["color"], "")
        self.assertEqual(got["breed"], "")
        self.assertFalse(got["refused"])
        self.assertIn("无法判断", got["reason"])

    def test_engine_attr_source_reports_pattern(self):
        from app import engine as engine_mod
        e = engine_mod.Engine.__new__(engine_mod.Engine)
        # attr_source 需要 clf.ok —— 用最小替身（_FakeClf 只有 __call__）
        e.clf = type("C", (), {"ok": False, "__call__": lambda self, im: ("", "", 0.0)})()
        self.assertEqual(e.attr_source, "pattern")

    def test_engine_uses_pattern_when_configured(self):
        from app import engine as engine_mod
        e = engine_mod.Engine.__new__(engine_mod.Engine)
        e.clf = type("C", (), {"ok": False, "__call__": lambda self, im: ("", "", 0.0)})()
        got = e.attrs(textured(WHITE), cropped=True, mask=self._mask())
        self.assertEqual(got["engine"], "pattern")
        self.assertEqual(got["color"], "white")


if __name__ == "__main__":
    unittest.main(verbosity=2)
