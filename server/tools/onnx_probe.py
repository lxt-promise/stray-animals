"""搜索可直接下载的 ONNX 权重（避开 torch，几百 MB 的省事路线）。

候选来源：
  Xenova/*         —— transformers.js 官方移植，仓库内必有 onnx/model.onnx
  onnx-community/* —— Optimum 自动导出的 ONNX 仓库
  ultralytics/assets —— YOLOv8 官方 ONNX 权重（走 GitHub Release）
"""
import concurrent.futures as cf
import os
import urllib.error
import urllib.request

ROOT = os.getenv("HF_ENDPOINT", "https://hf-mirror.com")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def head(url: str, timeout: int = 20) -> tuple[int, int]:
    """返回 (状态码, 文件大小)。重定向也算命中。"""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
    try:
        r = OPENER.open(req, timeout=timeout)
        size = int(r.headers.get("Content-Length") or 0)
        return r.status, size
    except urllib.error.HTTPError as e:
        size = int(e.headers.get("Content-Length") or 0) if e.headers else 0
        return e.code, size
    except Exception:
        return -1, 0


REPOS = [
    # --- 骨干备选：个体识别能力从强到弱 ---
    "Xenova/dinov2-large", "Xenova/dinov2-base", "Xenova/dinov2-small",
    "onnx-community/dinov2-base", "onnx-community/dinov2-large",
    "Xenova/clip-vit-base-patch32", "Xenova/clip-vit-large-patch14",
    # --- 可能的 already-exported 猫/动物 ReID ---
    "onnx-community/MegaDescriptor-L-384", "onnx-community/MegaDescriptor-S-224",
    "Xenova/MegaDescriptor-S-224",
]
FILES = ["onnx/model.onnx", "onnx/model_quantized.onnx", "model.onnx", "model_quantized.onnx"]

print(f"镜像源: {ROOT}\n")
print(f"{'仓库/文件':<52}{'状态':<8}大小")
print("-" * 78)

hits: list[tuple[str, str, int]] = []


def probe(item: tuple[str, str]):
    repo, f = item
    url = f"{ROOT}/{repo}/resolve/main/{f}"
    code, size = head(url)
    return repo, f, code, size


tasks = [(r, f) for r in REPOS for f in FILES]
with cf.ThreadPoolExecutor(max_workers=10) as ex:
    for repo, f, code, size in ex.map(probe, tasks):
        if code in (200, 301, 302, 303, 307, 308):
            mb = size / 2 ** 20
            print(f"{repo + '/' + f:<52}{'命中':<8}{mb:.0f} MB")
            hits.append((repo, f, size))
        elif code != 404:
            print(f"{repo + '/' + f:<52}{'HTTP ' + str(code):<8}")

print("\n" + "=" * 78)
if hits:
    print("可直接下载的 ONNX：")
    for repo, f, size in sorted(hits, key=lambda x: x[2]):
        print(f"  {ROOT}/{repo}/resolve/main/{f}   {size / 2**20:.0f} MB")
else:
    print("未找到现成 ONNX，只能走「装 torch → 自己导出」路线")

# YOLOv8 检测模型走 GitHub Release（ultralytics 官方资源）
GH = "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.onnx"
print("\n检测模型（猫体检测，COCO 里猫 class=15）:")
code, size = head(GH)
mark = "命中" if code in (200, 301, 302, 303, 307, 308) else f"HTTP {code}"
print(f"  {GH}\n  -> {mark} {size / 2**20:.0f} MB")
