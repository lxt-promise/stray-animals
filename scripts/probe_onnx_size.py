"""探测 reid.onnx 能接受的输入尺寸，找出模型真正期望的边长。

背景：/v1/index/build 线上报 500，ONNX 报错
  "Attempting to broadcast an axis by a dimension other than 1. 257 by 1370"
判定 Shape 不匹配后，用纯随机张量逐个尺寸试跑（不依赖图片，最快也最干净）。
"""
import os
import sys

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
sys.path.insert(0, SERVER)

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402

from app import config  # noqa: E402

SIZES = [int(x) for x in (sys.argv[1:] or [])] or [224, 256, 384, 518, 592]


def main():
    print("REID_ONNX =", config.REID_ONNX, " REID_SIZE =", config.REID_SIZE)
    sess = ort.InferenceSession(config.REID_ONNX, providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    for i in sess.get_inputs():
        print("  IN  ", i.name, i.shape, i.type)
    for o in sess.get_outputs():
        print("  OUT ", o.name, o.shape, o.type)
    print("-" * 60)
    for size in SIZES:
        x = np.random.rand(1, 3, size, size).astype(np.float32)
        try:
            outs = sess.run(None, {name: x})
            shapes = [tuple(np.asarray(o).shape) for o in outs]
            print("%4d -> OK    out=%s" % (size, shapes))
        except Exception as e:  # noqa: BLE001
            msg = str(e).replace("\n", " ")
            print("%4d -> FAIL  %s" % (size, msg[:110]))


if __name__ == "__main__":
    main()
