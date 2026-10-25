"""检测框坐标还原（`_detect_box_to_xyxy`）的回归。

这两条曾经是错的，而且**错得很安静** —— 会给出一个尺寸合理、位置离谱的框，
crop 出来是一块胸口/背景，再喂给 ReID 就等于随机采样。因为 `DETECT_ONNX`
默认不配，代码根本不跑到，所以只有真配了 YOLO 才会暴露。

真实数据（Wikimedia 的猫图，640×440，yolov8n 输出 conf=0.89）：
    模型输出 cx=283.5 cy=330.5 w=363.3 h=390.0
    旧代码 → [283, 227, 363, 268]   框出 80×60 一块胡须/胸口（废图）
    新代码 → [102, 36, 465, 426]    正好框住整只猫
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image  # noqa: E402

from app import config  # noqa: E402
from app.engine import (_detect_box_to_xyxy, _pad_box,  # noqa: E402
                        _pick_subject, _resolve_detect_model)


class TestDetectorBox(unittest.TestCase):

    def test_square_image_no_padding(self):
        """方图没有补边，缩放系数 1.0，等价于直接把 cxcywh 展成 xyxy。"""
        got = _detect_box_to_xyxy([320, 320, 200, 200], 640, 640, 640)
        self.assertEqual(got, [220, 220, 420, 420])

    def test_wide_image_letterbox_offset(self):
        """宽图上下补边 100px：y 必须先减 pad 再除缩放，否则整体上移 100px。"""
        got = _detect_box_to_xyxy([283.5, 330.5, 363.3, 390.0], 640, 440, 640)
        self.assertEqual(len(got), 4)
        for actual, expect in zip(got, [102, 36, 465, 426]):
            self.assertLessEqual(abs(actual - expect), 1,
                                 "还原后 %s 与期望 %s 差超过 1px" % (got, [102, 36, 465, 426]))

    def test_wide_image_old_bug_would_shift_vertically(self):
        """锁死旧 bug：按 w/size、h/size 缩放会让 y 从 36 变成 227。"""
        got = _detect_box_to_xyxy([283.5, 330.5, 363.3, 390.0], 640, 440, 640)
        self.assertLess(got[1], 100, "y1 应落在画面上部（猫头），而不是被压到 227")
        self.assertGreater(got[3], 380, "y2 应接近画面底部，说明覆盖整只猫")

    def test_tall_image_letterbox_offset(self):
        """竖图左右补边：box 覆盖整张原图时，还原后应正好等于原图尺寸。"""
        got = _detect_box_to_xyxy([320, 320, 320, 640], 400, 800, 640)
        self.assertEqual(got, [0, 0, 400, 800])

    def test_normalized_coordinates(self):
        """0~1 归一化的导出（部分 web/onnx 版本）也要能还原。"""
        got = _detect_box_to_xyxy([0.5, 0.5, 0.5, 0.5], 640, 640, 640)
        self.assertEqual(got, [160, 160, 480, 480])

    def test_clamped_to_image_bounds(self):
        """框越界时夹到画面内：PIL 对越界 crop 会静默补黑边，等于往特征里掺黑。"""
        got = _detect_box_to_xyxy([10, 10, 200, 200], 640, 640, 640)
        self.assertGreaterEqual(got[0], 0)
        self.assertGreaterEqual(got[1], 0)

    def test_degenerate_box_is_rejected(self):
        """宽或高退化时返回空，让调用方退回整图，而不是 crop 出 0 像素图。"""
        self.assertEqual(_detect_box_to_xyxy([100, 100, 0, 0], 640, 640, 640), [])
        self.assertEqual(_detect_box_to_xyxy([100, 100, 4, 300], 640, 640, 640), [])


_MODEL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "models", "yolov8n.onnx")
_CAT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "fixtures", "sample_cat.jpg")


class TestPickSubject(unittest.TestCase):
    """NMS + 按面积选主体。

    YOLO 导出的是未后处理的原始输出，同一只猫会给十几条高度重叠的框；
    不去重就按面积挑，很可能挑到同一只猫的另一个框，等于白算。
    """

    def test_picks_the_large_animal_not_the_highest_score(self):
        """断言打在意图上：选中的必须是那只大的，而不是分数最高的小框。

        具体落到哪条重复框无所谓（NMS 后留下的那条代表的都是同一只猫），
        所以判据是「面积」而不是下标 —— 用下标会把 NMS 的实现顺序写死进用例。
        """
        small = [0, 0, 50, 50]              # 面积 2500，分数最高
        big = [60, 60, 200, 200]            # 面积 19600，分数最低
        dups = [[61, 61, 199, 199], [60, 61, 200, 199], [59, 60, 201, 200]]
        boxes = [small, big] + dups
        idx = _pick_subject(boxes, [0.95, 0.60, 0.90, 0.88, 0.86])
        area = (boxes[idx][2] - boxes[idx][0]) * (boxes[idx][3] - boxes[idx][1])
        self.assertGreater(area, 15000, "选到了小框（面积 %d），应按面积选主体" % area)

    def test_distinct_objects_both_survive_nms(self):
        left, right = [0, 0, 80, 80], [200, 200, 300, 300]
        self.assertEqual(_pick_subject([left, right], [0.9, 0.5]), 1,
                         "两个不重叠的物体，面积大的那个才是画面主体")

    def test_empty_returns_minus_one(self):
        self.assertEqual(_pick_subject([], []), -1)


class TestPadBox(unittest.TestCase):

    def test_expands_proportionally(self):
        got = _pad_box([100, 100, 200, 200], 300, 300, 0.1)
        self.assertEqual(got, [90, 90, 210, 210])

    def test_clamped_at_border(self):
        got = _pad_box([0, 0, 100, 100], 200, 200, 0.1)
        self.assertEqual(got, [0, 0, 110, 110])

    def test_zero_ratio_is_noop(self):
        self.assertEqual(_pad_box([10, 20, 30, 40], 100, 100, 0), [10, 20, 30, 40])


class TestResolveDetectModel(unittest.TestCase):
    """模型来源的三条规则：显式关闭 > 显式路径 > 自动发现。"""

    def setUp(self):
        self._onnx, self._auto = config.DETECT_ONNX, config.DETECT_AUTO

    def tearDown(self):
        config.DETECT_ONNX, config.DETECT_AUTO = self._onnx, self._auto

    def test_off_keyword_disables_even_if_model_present(self):
        for word in ("off", "none", "0", "false"):
            config.DETECT_ONNX, config.DETECT_AUTO = word, True
            self.assertEqual(_resolve_detect_model(), "",
                             "DETECT_ONNX=%s 必须能关掉自动发现" % word)

    def test_explicit_path_wins(self):
        config.DETECT_ONNX = "/tmp/some/other.onnx"
        self.assertEqual(_resolve_detect_model(), "/tmp/some/other.onnx")

    def test_auto_off_returns_empty(self):
        config.DETECT_ONNX, config.DETECT_AUTO = "", False
        self.assertEqual(_resolve_detect_model(), "")

    @unittest.skipUnless(os.path.exists(_MODEL), "缺 models/yolov8n.onnx")
    def test_auto_finds_bundled_model(self):
        config.DETECT_ONNX, config.DETECT_AUTO = "", True
        self.assertEqual(_resolve_detect_model(), _MODEL)


@unittest.skipUnless(os.path.exists(_MODEL) and os.path.exists(_CAT),
                     "缺 models/yolov8n.onnx 或 tests/fixtures/sample_cat.jpg")
class TestDetectorRealImage(unittest.TestCase):
    """真模型 + 真猫图：光有数学测试不够，坐标系和预处理/模型对不上时数学照样"对"。"""

    @classmethod
    def setUpClass(cls):
        from app import config
        from app.engine import _Detector

        config.DETECT_ONNX = _MODEL
        cls.det = _Detector()
        cls.im = Image.open(_CAT).convert("RGB")

    def test_finds_the_cat(self):
        box = self.det(self.im)
        self.assertIsNotNone(box, "这张图里明确有一只猫，检测不该返回空")
        w, h = self.im.size
        x1, y1, x2, y2 = box
        self.assertTrue(0 <= x1 < x2 <= w and 0 <= y1 < y2 <= h, "框越界：%s" % (box,))

    def test_box_is_not_a_small_patch(self):
        """锁死「cxcywh 当 xyxy」：那种错会把整只猫读成右下角一小块（约 80×60）。"""
        box = self.det(self.im)
        w, h = self.im.size
        self.assertGreater((box[2] - box[0]) * (box[3] - box[1]), 0.15 * w * h,
                           "框只覆盖了画面 %d%%，把 cxcywh 当 xyxy 了？"
                           % int(100.0 * (box[2] - box[0]) * (box[3] - box[1]) / (w * h)))

    def test_box_starts_near_top(self):
        """锁死 letterbox 逆映射错位：旧写法会把 y 整体下移 100px，猫头被切掉。"""
        box = self.det(self.im)
        h = self.im.size[1]
        self.assertLess(box[1], 0.20 * h, "框顶部落在 %d（画面高 %d），猫头没框进来" % (box[1], h))


if __name__ == "__main__":
    unittest.main(verbosity=2)
