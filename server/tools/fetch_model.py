"""下载现成 ONNX 权重到 server/models/。

为什么要找现成 ONNX：本机没有 NVIDIA 显卡，装 torch 只是为了「导出」一次很不划算
（torch  wheel 本身几百 MB + timm 需源码构建）。直接拿 ONNX Runtime 跑 GPU-free 推理
是最省事、也是这台机器唯一合理的路线。
"""
from __future__ import annotations

import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = "https://hf-mirror.com"
OUT = Path(__file__).resolve().parents[1] / "models"
OUT.mkdir(parents=True, exist_ok=True)

TARGETS = [
    # (仓库, 文件名, 保存名, 说明)
    ("Xenova/dinov2-base", "onnx/model_quantized.onnx", "reid.onnx",
     "DINOv2-base 动态量化版：个体识别主干 ~90MB，CPU 上单图 ~100ms"),
]


def download(repo: str, fname: str, save_as: str, note: str) -> None:
    """支持断点续传的下载。

    注意：不能简单地「文件大于 1MB 就跳过」—— 中途被杀掉会留下截断文件，
    加载时才报 protobuf 解析失败，排查起来很费劲。这里改为用 HTTP Range 续传，
    并以「总长度是否写满」作为成功判断。
    """
    dst = OUT / save_as
    url = f"{ROOT}/{repo}/resolve/main/{fname}"
    print(f"\n>>> {note}")
    print(f"    {url}")

    headers = {"User-Agent": "Mozilla/5.0"}

    # 先探一次总长度
    req = urllib.request.Request(url, method="HEAD", headers=headers)
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            total = int(r.headers.get("Content-Length") or 0)
            accept_ranges = r.headers.get("Accept-Ranges") == "bytes"
    except Exception as e:
        print(f"[失败] 无法连接: {e}")
        return

    have = dst.stat().st_size if dst.exists() else 0
    if total and have >= total:
        print(f"[跳过] {save_as} 已完整下载（{have / 2**20:.1f} MB）")
        return
    if have:
        print(f"[续传] 已下载 {have / 2**20:.1f}/{total / 2**20:.1f} MB")

    if have and not accept_ranges:
        print("[提示] 服务端不支持断点续传，重新完整下载")
        have = 0
    if have:
        headers["Range"] = f"bytes={have}-"

    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            if have and r.status != 206:  # 服务端忽略 Range，说明要重下
                have = 0
                dst.unlink(missing_ok=True)
            with open(dst, "ab") as f:
                got, last = have, time.time()
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
                    if time.time() - last > 10:
                        pct = got / total * 100 if total else 0
                        print(f"    {got / 2**20:.1f}/{total / 2**20:.0f} MB ({pct:.0f}%)", flush=True)
                        last = time.time()
    except Exception as e:
        print(f"[中断] {save_as}: {e}")
        print(f"       已下载 {dst.stat().st_size / 2**20:.1f} MB，重跑本脚本即可续传")
        return

    size = dst.stat().st_size
    if total and size < total:
        print(f"[不完整] {size / 2**20:.1f}/{total / 2**20:.1f} MB，请重跑")
        return

    print(f"[完成] {dst}  {size / 2**20:.1f} MB  用时 {time.time() - t0:.0f}s")


if __name__ == "__main__":
    for repo, f, save, note in TARGETS:
        download(repo, f, save, note)
    print("\n模型目录：", OUT)
    for p in sorted(OUT.glob("*.onnx")):
        print(f"  {p.name:<24}{p.stat().st_size / 2**20:>8.1f} MB")
    sys.exit(0)
