"""验收模型权重：确认 ONNX 能被加载、输入尺寸一致、前向推理跑得通、延迟可接受。

这一步很有必要 —— 权重文件下载截断时，onnxruntime 会报 protobuf 解析失败，
早点发现比重跑一遍 90MB 下载省事。

    python tools/inspect_model.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

MODEL = ROOT / "models" / "reid.onnx"

if not MODEL.exists():
    print(f"未找到模型：{MODEL}")
    print("请先运行 python tools/fetch_model.py 下载")
    sys.exit(1)

mb = MODEL.stat().st_size / 2 ** 20
print(f"模型文件：{MODEL.name}  {mb:.1f} MB\n")

from app import config  # noqa: E402

try:
    import onnxruntime as ort
except ImportError:
    print("未安装 onnxruntime，请执行 pip install onnxruntime")
    sys.exit(1)

import numpy as np  # noqa: E402

print(f"onnxruntime   : {ort.__version__}")
print(f"可用执行后端  : {ort.get_available_providers()}")

t0 = time.time()
try:
    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
except Exception as e:
    print(f"\n[X] 加载失败：{type(e).__name__}: {str(e)[:200]}")
    print("    多半是文件下载不完整，删掉后重跑 tools/fetch_model.py（支持续传）")
    sys.exit(1)

print(f"加载耗时      : {time.time() - t0:.1f}s\n")

print("输入：")
inp = sess.get_inputs()[0]
print(f"  name = {inp.name}   shape = {inp.shape}   dtype = {inp.type}")
print("输出：")
for o in sess.get_outputs():
    print(f"  name = {o.name}   shape = {o.shape}")

# 形状是 [1,3,H,W] 还是 [1,3,H,W] 动态？给出建议的 REID_SIZE
if len(inp.shape) == 4 and isinstance(inp.shape[-1], int):
    print(f"\n建议 .env 里的 REID_SIZE = {inp.shape[-1]}")

# 用一张纯色图做一次前向，确认推理链路可用
from PIL import Image  # noqa: E402

size = inp.shape[-1] if isinstance(inp.shape[-1], int) else 224
im = Image.new("RGB", (640, 480), (200, 120, 60))
sys.path.insert(0, str(ROOT / "app"))


def letterbox(im: Image.Image, size: int) -> Image.Image:
    w, h = im.size
    s = size / max(w, h)
    im = im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.BICUBIC)
    canvas = Image.new("RGB", (size, size), (128, 128, 128))
    canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
    return canvas


a = np.asarray(letterbox(im, size), dtype=np.float32) / 255.0
a = (a - np.array(config.IMAGENET_MEAN, dtype=np.float32)) / np.array(config.IMAGENET_STD, dtype=np.float32)
x = np.transpose(a, (2, 0, 1))[None, ...]

outs = sess.run(None, {inp.name: x})
main = outs[0]
print(f"\n推理输出 shape : {np.asarray(main).shape}")

from app.engine import _pool, l2  # noqa: E402

v = l2(_pool(outs))
print(f"池化后向量维度 : {v.shape[0]}")
print(f"L2 范数        : {np.linalg.norm(v):.6f}（应为 1.0）")

t0 = time.time()
for _ in range(5):
    sess.run(None, {inp.name: x})
print(f"CPU 单次推理   : {(time.time() - t0) / 5 * 1000:.0f} ms")

print("\n模型可用。下一步启动服务：")
print("  ..\\env\\Scripts\\python -m uvicorn app.main:app --host 127.0.0.1 --port 8090")
