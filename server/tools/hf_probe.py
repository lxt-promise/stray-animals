"""检查 HuggingFace 上 MegaDescriptor 仓库的文件清单，看看有没有现成的 ONNX 权重。

有 ONNX 就完全不必装 torch（省几百 MB），直接用 onnxruntime 跑 CPU 推理。
国内访问 huggingface.co 通常不通，自动走 hf-mirror.com。
"""
import json
import os
import urllib.request

MIRROR = os.getenv("HF_ENDPOINT", "https://hf-mirror.com")
REPOS = [
    "BVRA/MegaDescriptor-L-384",
    "BVRA/MegaDescriptor-S-224",
    "BVRA/MegaDescriptor-B-224",
]

print(f"镜像源: {MIRROR}\n")

for repo in REPOS:
    url = f"{MIRROR}/api/models/{repo}"
    try:
        with urllib.request.urlopen(url, timeout=25) as r:
            d = json.load(r)
    except Exception as e:
        print(f"[X] {repo}: 查询失败 {e}")
        continue

    files = [s.get("rfilename", "") for s in d.get("siblings", [])]
    print(f"[OK] {repo}")
    onnx_files = [f for f in files if f.lower().endswith(".onnx")]
    pt_files = [f for f in files if f.lower().endswith((".pt", ".pth", ".safetensors", ".bin"))]
    print(f"     ONNX 权重 : {onnx_files or '无'}")
    print(f"     训练权重 : {pt_files or '无'}")
    print(f"     许可协议 : {d.get('cardData', {}).get('license', '未标注')}")
    print(f"     下载次数 : {d.get('downloads', 0)}")
    print()
