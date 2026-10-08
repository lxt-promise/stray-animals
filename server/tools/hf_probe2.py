"""用 HEAD 请求逐个探测文件名，绕开被 403 的 /api/models 接口。"""
import os
import urllib.request

ROOT = os.getenv("HF_ENDPOINT", "https://hf-mirror.com")
REPOS = ["BVRA/MegaDescriptor-L-384", "BVRA/MegaDescriptor-S-224"]
CANDIDATES = [
    "model.onnx",
    "reid.onnx",
    "model_fp16.onnx",
    "model_quantized.onnx",
    "open_clip_model.safetensors",
    "open_clip_pytorch_model.safetensors",
    "open_clip_pytorch_model.bin",
    "pytorch_model.bin",
    "model.safetensors",
    "config.json",
    "README.md",
]


def head(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
    # 禁止自动跟随重定向，重定向本身即为线索（会指向 CDN 真实地址）
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    op = urllib.request.build_opener(NoRedirect)
    try:
        r = op.open(req, timeout=20)
        return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return -1


for repo in REPOS:
    print(f"=== {repo}")
    for f in CANDIDATES:
        url = f"{ROOT}/{repo}/resolve/main/{f}"
        code = head(url)
        mark = "OK " if code == 200 else ("->  " if code in (301, 302, 303, 307, 308) else "X  ")
        if code != 404:
            print(f"   {mark}{f:<40} HTTP {code}")
    print()
