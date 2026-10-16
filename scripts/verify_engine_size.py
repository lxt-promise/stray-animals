"""验证 ReID 引擎的输入边长处理：模型实际接受多大、能否自动纠偏、向量是否正常。

用法（cwd 必须是 server/，模型相对路径依赖它）：
    python ../scripts/verify_engine_size.py            # 用 .env / 默认配置
    REID_SIZE=518 python ../scripts/verify_engine_size.py   # 模拟云端旧配置（应自动纠偏）
"""
import os
import sys

SERVER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
sys.path.insert(0, SERVER_DIR)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app import config, engine  # noqa: E402


def rand_img(seed, w, h):
    rs = np.random.RandomState(seed)
    return Image.fromarray((rs.rand(h, w, 3) * 255).astype("uint8"))


def main():
    print("配置 REID_SIZE =", config.REID_SIZE, " REID_ONNX =", config.REID_ONNX)
    eng = engine.get_engine()
    print("就绪：provider=%s  dim=%s  size=%s" % (eng.provider, eng.dim, eng.embedder.size))

    ims = [rand_img(1, 640, 480), rand_img(2, 300, 300), rand_img(3, 1024, 768)]
    vecs = []
    for i, im in enumerate(ims):
        res = eng.features(im)
        e = res[0]
        vecs.append(e)
        # 向量维度必须等于引擎声明的 dim —— 否则说明池化出错
        # （实测踩过：CLS 少剥 batch 维会把 [257,768] 摊平成 197376 维）
        assert e.shape == (eng.dim,), "向量维度 %s != 引擎 dim %s，池化实现有 bug" % (
            e.shape, eng.dim)
        print("  图%d -> dim=%s  前3维=%s" % (i + 1, e.shape, np.round(e[:3], 4)))

    ok = True
    again = eng.features(ims[0])[0]
    same = bool(np.allclose(vecs[0], again, atol=1e-6))
    diff = float(np.dot(vecs[0], vecs[1]))
    print("同一张图两次结果一致：", same)
    print("不同图的余弦相似度：%.4f（应远离 1，说明真的在分辨）" % diff)
    ok = ok and same and abs(diff) < 0.9999

    if eng.provider != "onnx":
        print("!! 走的不是 ONNX 引擎（占位/torch），本次验证无意义")
        ok = False
    print("结论：", "通过" if ok else "失败")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
