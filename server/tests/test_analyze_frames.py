"""多帧分析（`Engine.analyze_frames`）的行为回归。

这里锁的是三个**不会报错、只会变差**的退化：

  1. 每帧都检测 —— 功能正常，只是白花 N×65ms，而且多帧平均失去意义（视野不一致）；
  2. 中间帧没猫就直接整图提特征 —— 明明换个帧就能框到，却整段视频退化成无裁剪；
  3. 属性平均 —— 视频里的糊帧会把橘猫冲淡成「灰橘」，属性必须挑最清楚的那一帧。

用假检测器/假 embedder，不依赖 onnxruntime 和模型文件。
"""
import os
import sys
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app.engine as engine  # noqa: E402


class _CountingDetector:
    """记录被调用了几次、用的是哪一帧；可指定「只有这些宽度的帧能框到」。

    判定按**图片宽度**而不是调用次数 —— 调用次数会随回退顺序变化，
    用次数当判据等于把「顺序」写死进用例，改顺序就假失败。
    """

    def __init__(self, box, hits=None):
        self.box = box
        self.hits = hits          # None = 每帧都能框到；否则是可框到的帧宽度集合
        self.calls = []

    def detect(self, im):
        self.calls.append(im.size)
        if self.hits is not None and im.size[0] not in self.hits:
            return {"box": None, "core": None, "conf": 0.0,
                    "candidates": 0, "reason": "模型没有识别到猫体"}
        return {"box": list(self.box), "core": list(self.box),
                "conf": 0.9, "candidates": 10, "reason": ""}

    def __call__(self, im):        # 兼容旧接口
        return self.detect(im)["box"]


class _RecordingEmbedder:
    def __init__(self, dim=8):
        self.dim = dim
        self.sizes = []

    def __call__(self, im):
        self.sizes.append(im.size)
        return np.ones(self.dim, dtype=np.float32)


def _img(w=200, h=200, level=128):
    return Image.new("RGB", (w, h), (level, level, level))


def _engine(detector, dim=8):
    e = engine.Engine.__new__(engine.Engine)
    e.embedder = _RecordingEmbedder(dim)
    e.detector = detector
    e.clf = None
    e.dim = dim
    # 属性识别替换成「亮度即置信度」，方便验证挑的是分数最高那一帧
    e.attrs = lambda im, cropped=False: {
        "color": "orange" if im.getpixel((0, 0))[0] > 128 else "",
        "pattern": "solid", "breed": "橘猫",
        "confidence": im.getpixel((0, 0))[0] / 255.0,
        "source": "fake", "palette": [], "stripe": 0.0, "reason": "",
    }
    return e


class TestDetectOnce(unittest.TestCase):

    def test_detector_runs_once_for_many_frames(self):
        det = _CountingDetector([20, 20, 120, 120])
        e = _engine(det)
        out = e.analyze_frames([_img() for _ in range(8)])
        self.assertEqual(len(det.calls), 1,
                         "8 帧只该检测 1 次，实际 %d 次" % len(det.calls))
        self.assertEqual(len(out["embs"]), 8)

    def test_all_frames_cropped_by_the_same_box(self):
        det = _CountingDetector([20, 20, 120, 120])
        e = _engine(det)
        e.analyze_frames([_img() for _ in range(5)])
        self.assertEqual(len(set(e.embedder.sizes)), 1,
                         "复用同一个框时每帧 crop 尺寸必须一致，实际 %s"
                         % (set(e.embedder.sizes),))
        self.assertEqual(e.embedder.sizes[0], (100, 100))


class TestDetectFrameFallback(unittest.TestCase):

    def test_falls_back_to_another_frame_when_middle_has_no_cat(self):
        # 8 帧时 mid=4；只让宽度 200 的那帧（index 0）能框到
        frames = [_img(w=200 + i, h=200) for i in range(8)]
        det = _CountingDetector([10, 10, 90, 90], hits={200})
        e = _engine(det)
        out = e.analyze_frames(frames)
        self.assertTrue(out["detected"], "中间帧没猫时应继续试别的帧")
        self.assertEqual(len(det.calls), 2, "试到第 2 次就框到了，不该继续跑")
        self.assertEqual(det.calls[1], (200, 200), "第二次应该试到能框到的那帧")

    def test_gives_up_after_three_tries(self):
        det = _CountingDetector([10, 10, 90, 90], hits=set())
        e = _engine(det)
        out = e.analyze_frames([_img() for _ in range(20)])
        self.assertFalse(out["detected"])
        self.assertLessEqual(len(det.calls), 3, "不该把 20 帧全跑一遍")
        self.assertTrue(out["detectReason"], "没框到必须给出原因")

    def test_no_cat_degrades_to_full_image(self):
        det = _CountingDetector([10, 10, 90, 90], hits=set())
        e = _engine(det)
        out = e.analyze_frames([_img(160, 120)])
        self.assertIsNone(out["box"])
        self.assertEqual(e.embedder.sizes[0], (160, 120), "没框到应退回整图提特征")


class TestAttrPicksClearestFrame(unittest.TestCase):

    def test_highest_confidence_frame_wins(self):
        levels = [60, 200, 90]
        e = _engine(_CountingDetector([10, 10, 90, 90]))
        out = e.analyze_frames([_img(level=v) for v in levels])
        self.assertEqual(out["attr"]["color"], "orange", "应取最亮(=分数最高)那一帧")
        self.assertAlmostEqual(out["attr"]["confidence"], 200 / 255.0, places=3)


class TestEmbedDimGuardStillOn(unittest.TestCase):

    def test_wrong_dim_raises(self):
        e = _engine(_CountingDetector([10, 10, 90, 90]), dim=8)
        e.embedder = _RecordingEmbedder(dim=99)
        with self.assertRaises(RuntimeError):
            e.analyze_frames([_img()])


if __name__ == "__main__":
    unittest.main(verbosity=2)
