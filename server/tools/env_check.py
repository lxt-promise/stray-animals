"""本地环境体检：Python / 依赖 / ffmpeg / 模型源连通性。只读检查，不安装任何东西。"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

WARN = "[!]"
OK = "[OK]"
BAD = "[X]"


def head(t: str) -> None:
    print("\n" + "=" * 60)
    print(t)
    print("=" * 60)


def probe(url: str, timeout: int = 12) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, str(r.status)
    except Exception as e:
        return False, type(e).__name__ + ": " + str(e)[:70]


def pypi_tags(pkg: str, versions: list[str]) -> None:
    """查询某个包最新版是否提供当前平台可用的 wheel 标签。"""
    try:
        u = f"https://pypi.org/pypi/{pkg}/json"
        with urllib.request.urlopen(u, timeout=25) as r:
            d = json.load(r)
    except Exception as e:
        print(f"  {pkg:28s} 查询失败 {e}")
        return
    latest = d["info"]["version"]
    files = d["releases"].get(latest, [])
    tags = sorted({f["filename"].split("-")[-1].replace(".whl", "") for f in files if f["filename"].endswith(".whl")})
    py = f"cp{sys.version_info.major}{sys.version_info.minor}"
    hit = [t for t in tags if py in t and "win_amd64" in t]
    print(f"  {pkg:28s} latest={latest:12s} {py}-win_amd64 wheel: " + (", ".join(hit) if hit else f"{BAD} 无（需换 Python 3.12）"))
    for v in versions:
        fs = d["releases"].get(v, [])
        t2 = sorted({f["filename"].split("-")[-1].replace(".whl", "") for f in fs if f["filename"].endswith(".whl")})
        h2 = [t for t in t2 if py in t and "win_amd64" in t]
        if h2:
            print(f"  {pkg:28s} {v:12s} 可用")


head("1. 运行平台")
print(f"  系统            : {platform.system()} {platform.release()} ({platform.machine()})")
print(f"  Python          : {sys.version.split()[0]}  -> {sys.executable}")
print(f"  CPU 逻辑核      : {os.cpu_count()}")
print(f"  建议 installDir : E:\\app\\catrec")

head("2. 关键外部程序")
for tool in ["ffmpeg", "ffprobe", "docker", "docker-compose", "nvidia-smi", "git"]:
    p = shutil.which(tool)
    print(f"  {tool:16s}: " + (p if p else f"{BAD} 未安装/不在 PATH"))

given = Path(r"E:\Agent\project\opc-tools\video-service\ffmpeg\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe")
print(f"  指定 ffmpeg     : " + (f"{OK} {given}" if given.exists() else f"{BAD} 不存在"))
if given.exists():
    try:
        out = subprocess.run([str(given), "-version"], capture_output=True, text=True, timeout=15).stdout
        print("    " + out.splitlines()[0][:100])
    except Exception as e:
        print(f"    {WARN} 调用失败 {e}")

head("3. GPU / 加速")
try:
    out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                         capture_output=True, text=True, timeout=15)
    print("  " + (out.stdout.strip() if out.returncode == 0 else f"{BAD} 无 NVIDIA GPU -> 走 CPU 推理"))
except Exception:
    print(f"  {BAD} 未检测到 nvidia-smi -> 本机为核显/AMD，推理走 CPU（ONNX Runtime CPU 即可，不必装 CUDA 版 torch）")

head("4. Python 依赖包（wheel 可用性，非安装结果）")
py = f"cp{sys.version_info.major}{sys.version_info.minor}"
print(f"  当前解释器标签: {py}-win_amd64")
for pkg, vs in [("onnxruntime", []), ("torch", ["2.6.0", "2.7.0"]), ("timm", []),
                ("ultralytics", []), ("opencv-python-headless", [])]:
    pypi_tags(pkg, vs)

head("5. 模型源连通性")
for name, url in [
    ("PyPI", "https://pypi.org/simple/"),
    ("HuggingFace", "https://huggingface.co/BVRA/MegaDescriptor-L-384/resolve/main/README.md"),
    ("hf-mirror(国内镜像)", "https://hf-mirror.com/BVRA/MegaDescriptor-L-384/resolve/main/README.md"),
    ("GitHub", "https://github.com"),
]:
    ok, info = probe(url)
    print(f"  {name:22s}: " + (f"{OK} {info}" if ok else f"{BAD} {info}"))

head("6. 磁盘空间")
for d in ["C:\\", "E:\\"]:
    try:
        t = shutil.disk_usage(d)
        print(f"  {d}  可用 {t.free / 2**30:.1f} GB / 共 {t.total / 2**30:.1f} GB")
    except Exception as e:
        print(f"  {d} {e}")

print("\n体检结束。以上均为只读检查，未修改任何文件。")
