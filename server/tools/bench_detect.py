"""实测：猫体检测接入后的耗时（本机 CPU）。

用法：
    ../env/Scripts/python.exe tools/bench_detect.py                 # 默认（自动发现模型）
    DETECT_ONNX=off ../env/Scripts/python.exe tools/bench_detect.py  # 关检测做对照
不联网（fetch_image 被打桩），不依赖特征库内容。

三个数字分别对应：
  features()      单帧：检测 + 提特征 + 花色
  analyze_frames  8 帧：检测**只跑一次**，其余帧复用同一个框
  /v1/recognize   端到端：含解码、补库、检索、记账
"""
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
os.environ.setdefault("INDEX_BACKEND", "sqlite")
os.environ.setdefault("REID_ONNX", os.path.join(HERE, "models", "reid.onnx"))

from PIL import Image  # noqa: E402

from app import config, main, media  # noqa: E402
from app.engine import get_engine  # noqa: E402

IMG = os.path.join(HERE, "tests", "fixtures", "sample_cat.jpg")


def ms(t0):
    return (time.time() - t0) * 1000


def _timed(fn):
    t = time.time()
    fn()
    return ms(t)


def avg(fn, n=3):
    _timed(fn)                                  # 预热：首次会话创建不算稳态
    return statistics.mean(_timed(fn) for _ in range(n))


eng = get_engine()
print("provider=%s dim=%s detector=%s(%s) attrs=%s"
      % (eng.provider, eng.dim, bool(eng.detector.sess),
         os.path.basename(getattr(eng.detector, "path", "") or "-"),
         eng.attr_source))

im = Image.open(IMG).convert("RGB")
print("测试图 %dx%d" % im.size)

frames = [im] * 8
one = avg(lambda: eng.features(im))
print("features() 单帧            : %.0f ms" % one)
print("analyze_frames() 8 帧      : %.0f ms（检测只跑一次）" % avg(lambda: eng.analyze_frames(frames)))

media.fetch_image = lambda url: Image.open(IMG).convert("RGB")
req = main.RecognizeReq(url="http://x/a.jpg", type="image", schoolId="s1")
main.recognize(req, None)
r = main.recognize(req, None)
print("/v1/recognize 端到端        : %.0f ms  timing=%s"
      % (avg(lambda: main.recognize(req, None)), r["meta"]["timing"]))
print("  检测框=%s conf=%.2f 候选框=%d  花色=%s/%s(%s)"
      % (r["meta"]["crop"], r["meta"]["detectConf"], r["meta"]["detectCandidates"],
         r["features"]["color"] or "-", r["features"]["pattern"] or "-",
         r["features"]["attrSource"] or "-"))
