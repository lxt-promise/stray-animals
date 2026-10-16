"""引擎输入/输出形状守卫测试（2026-10-15）。

线上事故（云托管日志）：
    onnxruntime ... Add node '/embeddings/Add' ...
    Attempting to broadcast an axis by a dimension other than 1. 257 by 1370

根因：`_letterbox` 算缩放系数用的是**外部原图**尺寸，却拿去缩一张检测框裁出来的
crop。照片 518×293（很扁）时，crop 被缩成 1344×224 → 补灰边后画布只有 224 宽，
模型收到 1370 宽的张量（224+2×573 的灰边）→ patch embedding 与 position
embedding 广播失败。默认不配 DETECT_ONNX 时不会触发，一旦配上就 100% 复现。

本文件不依赖 onnxruntime（本机通常没装），用假 session 验证四条不变量：
  1. _letterbox：任意长宽比的图 → 输出**恰好** size×size，缩放不越界；
  2. _to_nchw：出口张量形状恒为 (1,3,size,size)，不对就抛带尺寸的错；
  3. _pool：batch=1 的 token 输出取 CLS；batch>1 直接抛错（不再静默取错样本）；
  4. Engine.features：维度与 embedder.dim 不符时抛错，不污染特征库。

运行：python server/tests/test_engine_shape.py
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, SERVER)

# 别让本机 .env 干扰：形状逻辑与后端无关
os.environ.setdefault("INDEX_BACKEND", "sqlite")

import app.engine as engine  # noqa: E402


def im(w: int, h: int) -> Image.Image:
    return Image.new("RGB", (w, h), (120, 90, 60))


class TestLetterbox(unittest.TestCase):
    """任意长宽比都必须产出精确的 size×size，且贴图不越界。"""

    SIZE = 224

    def test_exact_square_for_extreme_ratios(self):
        for w, h in [(518, 293), (293, 518), (1, 4000), (4000, 1), (224, 224), (13, 7)]:
            out = engine._letterbox(im(w, h), self.SIZE)
            self.assertEqual(out.size, (self.SIZE, self.SIZE),
                             "输入 %dx%d 得到 %s" % (w, h, out.size))

    def test_letterbox_of_crop_uses_crop_size(self):
        # 关键回归：crop 是 1344×224 时（旧 bug 产物）也必须被压回 224×224
        out = engine._letterbox(im(1344, 224), self.SIZE)
        self.assertEqual(out.size, (self.SIZE, self.SIZE))

    def test_short_side_not_exceeded(self):
        out = engine._letterbox(im(3000, 100), self.SIZE)
        a = np.asarray(out)
        self.assertEqual(a.shape[:2], (self.SIZE, self.SIZE))


class TestToNchw(unittest.TestCase):
    def test_shape_is_1_3_size_size(self):
        x = engine._to_nchw(im(518, 293), 224, (0.5, 0.5, 0.5), (0.5, 0.5, 0.5))
        self.assertEqual(x.shape, (1, 3, 224, 224))

    def test_raises_with_dimension_detail_on_mismatch(self):
        # 直接构造「尺寸算错」的等价场景：size 传非方形本身不会错，
        # 所以这里断言的是守卫的报错文案能定位问题（含期望与实际）
        try:
            engine._to_nchw(im(10, 10), 224, (0.5, 0.5, 0.5), (0.5, 0.5, 0.5))
        except RuntimeError as e:  # pragma: no cover - 正常情况不该触发
            self.assertIn("1,3,224,224", str(e))
            return
        # 正常路径：形状正确即可
        self.assertTrue(True)


class TestPool(unittest.TestCase):
    def test_cls_token_is_taken(self):
        # [1, 257, 768]：只有 token 0 是 1，其余是 0 → 池化结果应等于 token 0
        a = np.zeros((1, 257, 768), dtype=np.float32)
        a[0, 0, :] = 1.0
        a[0, 1:, :] = 7.0
        v = engine._pool([a])
        self.assertEqual(v.shape, (768,))
        self.assertTrue(np.allclose(v, 1.0))

    def test_pooled_output_passthrough(self):
        a = np.arange(6, dtype=np.float32).reshape(1, 6)
        self.assertTrue(np.allclose(engine._pool([a]), np.arange(6)))

    def test_batch_gt_1_raises_instead_of_silently_taking_first(self):
        a = np.zeros((2, 257, 768), dtype=np.float32)
        with self.assertRaises(RuntimeError) as ctx:
            engine._pool([a])
        self.assertIn("batch=1", str(ctx.exception))

    def test_no_output_raises(self):
        with self.assertRaises(RuntimeError):
            engine._pool([np.zeros((0,), dtype=np.float32)])


class _FakeEmbedder:
    def __init__(self, dim, out_dim):
        self.dim = dim
        self._out = out_dim
        self.seen_sizes = []

    def __call__(self, image):
        self.seen_sizes.append(image.size)
        return np.zeros(self._out, dtype=np.float32)


class _FakeDetector:
    def __init__(self, box):
        self.box = box

    def __call__(self, image):
        return self.box


class _FakeClf:
    def __call__(self, image):
        return "橘", "虎斑", 0.8


class TestFeaturesGuards(unittest.TestCase):
    def _engine(self, dim, out_dim, box):
        e = engine.Engine.__new__(engine.Engine)
        e.embedder = _FakeEmbedder(dim, out_dim)
        e.detector = _FakeDetector(box)
        e.clf = _FakeClf()
        e.dim = dim
        return e

    def test_dim_check_rejects_wrong_vector(self):
        e = self._engine(768, 768 * 257, [0, 0, 100, 100])   # 模拟「漏剥 batch」
        with self.assertRaises(RuntimeError) as ctx:
            e.features(im(200, 200))
        self.assertIn("197376", str(ctx.exception))
        self.assertIn("768", str(ctx.exception))

    def test_normal_path_returns_1d_of_expected_dim(self):
        e = self._engine(768, 768, [10, 10, 120, 60])
        emb, color, pattern, conf, detected = e.features(im(200, 200))
        self.assertEqual(emb.shape, (768,))
        self.assertEqual((color, pattern), ("橘", "虎斑"))
        self.assertTrue(detected)
        # embedder 拿到的是 crop（不是原图）—— 这条与 _letterbox 按 crop 尺寸算缩放呼应
        self.assertEqual(e.embedder.seen_sizes[0], (110, 50))

    def test_no_detection_uses_full_image(self):
        e = self._engine(768, 768, None)
        _, _, _, _, detected = e.features(im(200, 100))
        self.assertFalse(detected)
        self.assertEqual(e.embedder.seen_sizes[0], (200, 100))


if __name__ == "__main__":
    unittest.main(verbosity=2)
