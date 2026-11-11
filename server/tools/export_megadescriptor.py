# -*- coding: utf-8 -*-
"""导出 MegaDescriptor-T-224 为 ONNX（动物 ReID 专用，28M 参数）。

用法：python tools/export_megadescriptor.py
输出：models/mega_descriptor_t.onnx

与当前 reid.onnx (DINOv2 ViT-Base, 86M) 的区别：
  - 动物 ReID 专用，论文实测优于 DINOv2/CLIP
  - 参数量 28M（3 倍更轻）
  - 归一化 [0.5,0.5,0.5]（非 ImageNet）
  - 输出已池化的 768 维向量（无需 CLS 池化）
"""
import os, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import torch
import timm

OUT = ROOT / "models" / "mega_descriptor_t.onnx"
MODEL = "hf-hub:BVRA/MegaDescriptor-T-224"
SIZE = 224

print("加载模型:", MODEL)
t0 = time.time()
model = timm.create_model(MODEL, pretrained=True, num_classes=0)
model.eval()
print(f"  加载耗时 {time.time()-t0:.1f}s，参数量 {sum(p.numel() for p in model.parameters())/1e6:.1f}M")

# 确认输出维度
dummy = torch.randn(1, 3, SIZE, SIZE)
with torch.no_grad():
    out = model(dummy)
print(f"  输出 shape: {tuple(out.shape)}")

print("导出 ONNX ...")
t0 = time.time()
torch.onnx.export(
    model,
    dummy,
    str(OUT),
    input_names=["pixel_values"],
    output_names=["embedding"],
    dynamic_axes={"pixel_values": {0: "batch"}, "embedding": {0: "batch"}},
    opset_version=17,
    do_constant_folding=True,
)
print(f"  导出耗时 {time.time()-t0:.1f}s")
mb = OUT.stat().st_size / 2**20
print(f"  文件大小: {mb:.1f} MB")

# 验证 ONNX 能跑
print("\n验证 ONNX 推理 ...")
import onnxruntime as ort
import numpy as np
sess = ort.InferenceSession(str(OUT), providers=["CPUExecutionProvider"])
inp = sess.get_inputs()[0]
print(f"  输入: {inp.name} {inp.shape}")
x = (np.random.randn(1, 3, SIZE, SIZE).astype(np.float32) - 0.5) / 0.5
t0 = time.time()
for _ in range(5):
    y = sess.run(None, {inp.name: x})[0]
print(f"  输出: {y.shape}，CPU 单次 {(time.time()-t0)/5*1000:.0f} ms")
print(f"  L2 范数: {np.linalg.norm(y):.4f}")
print("\n导出完成:", OUT)
