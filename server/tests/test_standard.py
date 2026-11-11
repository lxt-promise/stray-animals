# -*- coding: utf-8 -*-
"""猫咪标准照生成（/v1/photo/standard）的回归测试。

锁住四件事：
  1. 提示词固定两组（正面 / 全身），skill 里的风格与防崩坏约束不能丢；
  2. 未配置 IMAGE_GEN_URL 时必须抛 ProviderNotConfigured（路由据此返回 503），
     **不能**静默生成一张本地拼图；
  3. 远端响应的三种常见形态（raw image / b64_json / url）都能解出图片；
  4. 命名约定 xx1 = 全身站姿照、xx2 = 正面标准照，且 save 落盘行为符合预期。
"""
from __future__ import annotations

import asyncio
import base64
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from app import config, standard  # noqa: E402


def _png(color=(200, 80, 40), size=(12, 12)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


class _FakeResponse:
    def __init__(self, status_code=200, headers=None, content=b"", payload=None):
        self.status_code = status_code
        self.headers = headers or {}
        self.content = content
        self._payload = payload

    @property
    def text(self):
        return str(self._payload or self.content[:200])

    def json(self):
        return self._payload


class TestPrompts(unittest.TestCase):
    def test_two_groups(self):
        p = standard.build_prompts("三花猫")
        self.assertIn("正面标准证件照", p["front"])
        self.assertIn("全身站姿照", p["fullBody"])
        self.assertIn("三花猫", p["front"])
        self.assertIn("三花猫", p["fullBody"])
        # skill 要求的防瑕疵约束必须两组都有
        self.assertIn("肢体错乱", p["front"])
        self.assertIn("畸形耳朵", p["front"])
        self.assertIn("肢体错乱", p["fullBody"])
        self.assertIn("畸形耳朵", p["fullBody"])

    def test_default_style_and_extra(self):
        p = standard.build_prompts("", style="", extra="")
        self.assertIn(standard.DEFAULT_STYLE, p["front"])
        self.assertIn("一只猫", p["front"])
        p2 = standard.build_prompts("玄猫", style="胶片摄影", extra="暖色灯光")
        self.assertIn("胶片摄影", p2["front"])
        self.assertIn("暖色灯光", p2["front"])


class TestName(unittest.TestCase):
    def test_sanitize(self):
        self.assertEqual(standard._safe_name(" 三花猫 ", ""), "三花猫")
        self.assertEqual(standard._safe_name("a/b:c", ""), "abc")
        self.assertEqual(standard._safe_name("", ""), "cat")
        self.assertEqual(standard._safe_name("", "三花猫"), "三花猫")
        self.assertEqual(len(standard._safe_name("x" * 40, "")), 32)


class TestProvider(unittest.TestCase):
    def test_not_configured(self):
        with mock.patch.object(config, "IMAGE_GEN_URL", ""), \
             mock.patch.object(config, "AGNES_API_KEY", ""):
            with self.assertRaises(standard.ProviderNotConfigured):
                standard._provider_call("a cat", "square_hd")

    def test_raw_image_response(self):
        resp = _FakeResponse(headers={"content-type": "image/png"}, content=_png())
        with mock.patch.object(config, "IMAGE_GEN_URL", "https://x/gen"), \
             mock.patch.object(standard.httpx, "get", return_value=resp) as get:
            raw = standard._provider_call("a cat", "square_hd")
        self.assertEqual(raw, _png())
        # 没有占位符时自动拼 query
        self.assertIn("prompt=", get.call_args[0][0])
        self.assertIn("image_size=square_hd", get.call_args[0][0])

    def test_template_placeholders(self):
        resp = _FakeResponse(headers={"content-type": "image/png"}, content=_png())
        with mock.patch.object(config, "IMAGE_GEN_URL",
                               "https://x/gen?p={prompt}&s={image_size}"), \
             mock.patch.object(standard.httpx, "get", return_value=resp) as get:
            standard._provider_call("三花猫 正面", "square_hd")
        url = get.call_args[0][0]
        self.assertIn("s=square_hd", url)
        self.assertIn("%E4%B8%89", url)  # 「三」的 URL 编码，说明 prompt 已编码

    def test_token_header(self):
        resp = _FakeResponse(headers={"content-type": "image/png"}, content=_png())
        with mock.patch.object(config, "IMAGE_GEN_URL", "https://x/gen"), \
             mock.patch.object(config, "IMAGE_GEN_TOKEN", "secret"), \
             mock.patch.object(standard.httpx, "get", return_value=resp) as get:
            standard._provider_call("a cat", "square")
        self.assertEqual(get.call_args[1]["headers"]["Authorization"], "Bearer secret")

    def test_json_b64_json(self):
        payload = {"data": [{"b64_json": base64.b64encode(_png()).decode()}]}
        self.assertEqual(standard._bytes_from_payload(payload), _png())

    def test_json_data_url(self):
        b64 = base64.b64encode(_png()).decode()
        self.assertEqual(standard._bytes_from_payload({"image": "data:image/png;base64," + b64}),
                         _png())

    def test_json_url(self):
        with mock.patch.object(standard.media, "download_bytes", return_value=_png()) as dl:
            self.assertEqual(standard._bytes_from_payload({"data": [{"url": "https://x/a.png"}]}),
                             _png())
        dl.assert_called_once()

    def test_json_without_image_gives_reason(self):
        with self.assertRaises(standard.GenerationError) as ctx:
            standard._bytes_from_payload({"code": 1001, "message": "not authenticated"})
        self.assertIn("not authenticated", str(ctx.exception))

    def test_non_200(self):
        resp = _FakeResponse(status_code=401, payload={"message": "bad token"})
        with mock.patch.object(config, "IMAGE_GEN_URL", "https://x/gen"), \
             mock.patch.object(standard.httpx, "get", return_value=resp):
            with self.assertRaises(standard.GenerationError) as ctx:
                standard._provider_call("a cat", "square")
        self.assertIn("401", str(ctx.exception))

    def test_non_image_content(self):
        resp = _FakeResponse(headers={"content-type": "text/html"}, content=b"<html>")
        with mock.patch.object(config, "IMAGE_GEN_URL", "https://x/gen"), \
             mock.patch.object(standard.httpx, "get", return_value=resp):
            with self.assertRaises(standard.GenerationError):
                standard._provider_call("a cat", "square")

    def test_ensure_png_rejects_garbage(self):
        with self.assertRaises(standard.GenerationError):
            standard._ensure_png(b"not an image")

    def test_ensure_png_converts_jpeg(self):
        buf = io.BytesIO()
        Image.new("RGB", (10, 10), (0, 0, 0)).save(buf, "JPEG")
        out = standard._ensure_png(buf.getvalue())
        self.assertTrue(out.startswith(b"\x89PNG"))


class TestReference(unittest.TestCase):
    """i2i 参考图：原图必须被压到 1024 内再以 JPEG data URI 发出。"""

    def test_data_uri_resized(self):
        im = Image.new("RGB", (2000, 1500), (210, 120, 40))
        uri = standard._reference_data_uri(im)
        self.assertTrue(uri.startswith("data:image/jpeg;base64,"))
        raw = base64.b64decode(uri.partition(",")[2])
        ref = Image.open(io.BytesIO(raw))
        ref.load()
        self.assertLessEqual(max(ref.size), standard.REF_MAX_SIDE)
        self.assertEqual(ref.format, "JPEG")

    def test_small_image_kept(self):
        im = Image.new("RGB", (64, 64), (10, 10, 10))
        uri = standard._reference_data_uri(im)
        raw = base64.b64decode(uri.partition(",")[2])
        self.assertEqual(Image.open(io.BytesIO(raw)).size, (64, 64))


class TestAgnesProvider(unittest.TestCase):
    """agnes 图片模型（/images/generations）：带 image 字段即走 i2i。"""

    def _resp(self, payload, status=200):
        return _FakeResponse(status_code=status, payload=payload)

    def test_sends_reference_and_returns_url_image(self):
        payload = {"data": [{"url": "https://x/a.png"}]}
        with mock.patch.object(config, "AGNES_API_KEY", "k"), \
             mock.patch.object(config, "IMAGE_GEN_MODEL", "agnes-image-2.1-flash"), \
             mock.patch.object(config, "IMAGE_GEN_SIZE_FULL", "2048x1536"), \
             mock.patch.object(standard.httpx, "post",
                               return_value=self._resp(payload)) as post, \
             mock.patch.object(standard.media, "download_bytes",
                               return_value=_png()) as dl:
            raw = standard._agnes_image_call("a cat", "2048x1536",
                                             "data:image/jpeg;base64,AAAA")
        self.assertEqual(raw, _png())
        body = post.call_args[1]["json"]
        self.assertEqual(body["size"], "2048x1536")
        self.assertEqual(body["model"], "agnes-image-2.1-flash")
        self.assertEqual(body["image"], "data:image/jpeg;base64,AAAA")
        self.assertEqual(post.call_args[1]["headers"]["Authorization"], "Bearer k")
        dl.assert_called_once()

    def test_without_reference_has_no_image_field(self):
        payload = {"data": [{"b64_json": base64.b64encode(_png()).decode()}]}
        with mock.patch.object(config, "AGNES_API_KEY", "k"), \
             mock.patch.object(standard.httpx, "post",
                               return_value=self._resp(payload)) as post:
            raw = standard._agnes_image_call("a cat", "1024x1024")
        self.assertEqual(raw, _png())
        self.assertNotIn("image", post.call_args[1]["json"])

    def test_not_configured(self):
        with mock.patch.object(config, "AGNES_API_KEY", ""):
            with self.assertRaises(standard.ProviderNotConfigured):
                standard._agnes_image_call("a cat", "1024x1024")

    def test_http_error_carries_message(self):
        resp = self._resp({"error": {"message": "team not allowed to access model"}}, 403)
        with mock.patch.object(config, "AGNES_API_KEY", "k"), \
             mock.patch.object(standard.httpx, "post", return_value=resp):
            with self.assertRaises(standard.GenerationError) as ctx:
                standard._agnes_image_call("a cat", "1024x1024")
        self.assertIn("403", str(ctx.exception))
        self.assertIn("not allowed", str(ctx.exception))

    def test_provider_prefers_agnes_when_url_empty(self):
        payload = {"data": [{"b64_json": base64.b64encode(_png()).decode()}]}
        with mock.patch.object(config, "IMAGE_GEN_URL", ""), \
             mock.patch.object(config, "AGNES_API_KEY", "k"), \
             mock.patch.object(standard.httpx, "post",
                               return_value=self._resp(payload)):
            self.assertEqual(standard._provider_call("a cat", "1024x1024"), _png())


class TestGenerate(unittest.TestCase):
    def _im(self):
        return Image.new("RGB", (32, 32), (120, 120, 120))

    def test_two_images_and_naming(self):
        with mock.patch.object(config, "IMAGE_GEN_URL", ""), \
             mock.patch.object(config, "AGNES_API_KEY", ""), \
             mock.patch.object(config, "IMAGE_GEN_SIZE_FULL", "2048x1536"), \
             mock.patch.object(config, "IMAGE_GEN_SIZE_FRONT", "2048x2048"), \
             mock.patch.object(standard, "_auto_animal",
                               return_value=("三花猫", True, {"breed": "三花猫", "color": "calico"})), \
             mock.patch.object(standard, "_provider_call", return_value=_png()) as call:
            out = standard.generate_standard(self._im(), name="三花猫")
        images = out["images"]
        self.assertEqual(len(images), 2)
        self.assertEqual(images[0]["kind"], standard.KIND_FULL)
        self.assertEqual(images[0]["filename"], "三花猫1.png")
        self.assertEqual(images[0]["label"], "全身站姿照")
        self.assertEqual(images[0]["imageSize"], "2048x1536")
        self.assertEqual(images[1]["kind"], standard.KIND_FRONT)
        self.assertEqual(images[1]["filename"], "三花猫2.png")
        self.assertEqual(images[1]["label"], "正面标准照")
        self.assertEqual(images[1]["imageSize"], "2048x2048")
        self.assertEqual(call.call_count, 2)
        self.assertEqual(out["animal"], "三花猫")
        self.assertEqual(out["animalSource"], "auto")
        self.assertTrue(out["detected"])
        self.assertFalse(out["reference"])
        for it in images:
            self.assertTrue(it["png"].startswith(b"\x89PNG"))
            self.assertIn("三花猫", it["prompt"])

    def test_reference_used_by_default(self):
        """默认后端（agnes）必须带原图参考：题头含约束，第三参数是 data URI。"""
        im = Image.new("RGB", (400, 300), (210, 120, 40))
        with mock.patch.object(config, "IMAGE_GEN_URL", ""), \
             mock.patch.object(config, "AGNES_API_KEY", "k"), \
             mock.patch.object(standard, "_auto_animal",
                               return_value=("橘狸花", True, {"breed": "橘狸花"})), \
             mock.patch.object(standard, "_provider_call", return_value=_png()) as call:
            out = standard.generate_standard(im, name="橘猫")
        self.assertEqual(out["provider"], "agnes")
        self.assertTrue(out["reference"])
        for it in out["images"]:
            self.assertIn("参考照片", it["prompt"])
        ref_arg = call.call_args[0][2]
        self.assertTrue(ref_arg.startswith("data:image/jpeg;base64,"))

    def test_animal_from_request_skips_analysis(self):
        with mock.patch.object(config, "IMAGE_GEN_URL", ""), \
             mock.patch.object(config, "AGNES_API_KEY", ""), \
             mock.patch.object(standard, "_auto_animal", side_effect=AssertionError("不应调用")), \
             mock.patch.object(standard, "_provider_call", return_value=_png()):
            out = standard.generate_standard(self._im(), animal="玄猫")
        self.assertEqual(out["animal"], "玄猫")
        self.assertEqual(out["animalSource"], "request")
        self.assertEqual(out["images"][0]["filename"], "玄猫1.png")

    def test_save_writes_files(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(config, "IMAGE_GEN_URL", ""), \
             mock.patch.object(config, "AGNES_API_KEY", ""), \
             mock.patch.object(config, "IMAGE_GEN_DIR", d), \
             mock.patch.object(standard, "_provider_call", return_value=_png()):
            out = standard.generate_standard(self._im(), animal="白猫", name="白猫", save=True)
            for it in out["images"]:
                p = Path(it["path"])
                self.assertTrue(p.exists())
                self.assertEqual(p.read_bytes(), it["png"])
            self.assertTrue((Path(d) / "白猫1.png").exists())
            self.assertTrue((Path(d) / "白猫2.png").exists())

    def test_save_requires_dir(self):
        with mock.patch.object(config, "IMAGE_GEN_URL", ""), \
             mock.patch.object(config, "AGNES_API_KEY", ""), \
             mock.patch.object(config, "IMAGE_GEN_DIR", ""), \
             mock.patch.object(standard, "_provider_call", return_value=_png()):
            with self.assertRaises(standard.GenerationError):
                standard.generate_standard(self._im(), animal="白猫", save=True)

    def test_analysis_failure_degrades_to_cat(self):
        with mock.patch.object(config, "IMAGE_GEN_URL", ""), \
             mock.patch.object(config, "AGNES_API_KEY", ""), \
             mock.patch.object(standard, "_auto_animal", return_value=("猫", False, {})), \
             mock.patch.object(standard, "_provider_call", return_value=_png()):
            out = standard.generate_standard(self._im())
        self.assertEqual(out["animal"], "猫")
        self.assertIn("一只猫", out["images"][0]["prompt"])


class _FakeRequest:
    def __init__(self, ctype, payload=None, raw=b"", query=None):
        self.headers = {"content-type": ctype}
        self._payload = payload
        self._raw = raw
        self.query_params = query or {}

    async def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    async def body(self):
        return self._raw


class TestRequestParsing(unittest.TestCase):
    def test_json(self):
        from app import main
        req = asyncio.run(main._standard_req(_FakeRequest(
            "application/json", {"animal": "三花猫", "name": "x", "save": True})))
        self.assertEqual(req.animal, "三花猫")
        self.assertTrue(req.save)

    def test_bad_json(self):
        from app import main
        with self.assertRaises(Exception) as ctx:
            asyncio.run(main._standard_req(_FakeRequest("application/json", [1, 2])))
        self.assertEqual(getattr(ctx.exception, "status_code", None), 400)

    def test_raw_image_body(self):
        from app import main
        raw = _png()
        req = asyncio.run(main._standard_req(_FakeRequest(
            "image/png", raw=raw, query={"animal": "玄猫", "save": "true"})))
        self.assertEqual(req.animal, "玄猫")
        self.assertTrue(req.save)
        self.assertEqual(base64.b64decode(req.imageBase64), raw)

    def test_empty_image_body(self):
        from app import main
        with self.assertRaises(Exception) as ctx:
            asyncio.run(main._standard_req(_FakeRequest("image/png", raw=b"")))
        self.assertEqual(getattr(ctx.exception, "status_code", None), 400)


if __name__ == "__main__":
    unittest.main()
